import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../src/composition-root.js';
import { createApp } from '../../src/server.js';
import { RedisSessionStore } from '../../src/modules/identity/infrastructure/session/RedisSessionStore.js';
import type { TenantSessionContext } from '../../src/modules/identity/application/ports/SessionStore.js';
import { TenantId } from '../../src/shared-kernel/domain/value-objects/TenantId.js';
import { bearer, getRequest, postJson, postRaw, startTestServer, type TestServerHandle } from './httpTestClient.js';

/**
 * Role/permission FORGES dans une requete HTTP authentifiee — niveau HTTP REEL (volet "role" du
 * critere "tenantId/role forge" de la cloture de Phase 0 ; le volet `tenantId` est deja prouve par
 * `test/audit/integration/auditHttpIsolation.test.ts`, dont ce fichier reprend litteralement le
 * dispositif : VRAI `buildCompositionRoot()` + `createApp()`, sessions plantees directement dans
 * Redis, requetes `node:http` reelles via `httpTestClient.ts`, aucun routeur ni middleware mocke).
 *
 * CE QUI MANQUAIT : `test/server/rbacMatrix.test.ts` prouve la REGLE de decision
 * (`authorizeAuditRead`) sur un principal construit EN MEMOIRE (`principalFor(role)`) — aucun test
 * ne passait jusqu'ici par une VRAIE requete HTTP pour verifier qu'un client ne peut pas
 * FOURNIR lui-meme le role/les permissions qui alimentent cette decision. C'est exactement l'ecart
 * entre "la regle est bonne" et "l'entree de la regle n'est pas fournie par l'attaquant".
 *
 * VECTEURS COUVERTS (les seuls existants a ce stade, inventaire fait sur `server.ts` : deux
 * endpoints authentifies, l'un a query string, l'autre a corps JSON) :
 *   1. query string de `GET /api/v1/audit-entries` (`ListAuditEntriesQuerySchema` `.strict()`) ;
 *   2. en-tetes HTTP arbitraires (`buildRequireAuthenticatedContext` ne lit QUE `authorization`
 *      et `x-correlation-id` — voir composition-root.ts) ;
 *   3. corps JSON de `POST /api/v1/platform/super-admin/break-glass-requests`
 *      (`RequestSuperAdminBreakGlassBodySchema` `.strict()`) ;
 *   4. corps JSON de l'approbation break-glass (`z.object({}).strict()`) ;
 *   5. pollution de prototype (`__proto__`) dans un corps JSON.
 *
 * PRINCIPAL DE TEST : session TENANT reelle portant `ACCUEIL` (role standard du catalogue
 * systeme, SANS `audit:read`, SANS statut plateforme) — deliberement pas `ADMIN_ETABLISSEMENT` :
 * il faut un role dont l'elevation VISEE (`audit:read`, `SUPER_ADMIN`) changerait REELLEMENT
 * l'issue, sinon le test serait faussement vert.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('Role/permission forges dans une requete HTTP authentifiee — sans aucun effet sur l_autorisation', () => {
  let root: CompositionRoot;
  let handle: TestServerHandle;
  let sessionStore: RedisSessionStore;

  const tenantId = randomUUID();
  const userId = randomUUID();
  const sessionStandard = randomUUID();

  const AUDIT_PATH = '/api/v1/audit-entries';
  const BREAK_GLASS_PATH = '/api/v1/platform/super-admin/break-glass-requests';

  /**
   * En-tetes que porterait un client malveillant esperant qu'un middleware "de confiance" les
   * lise. AUCUN n'est lu par `buildRequireAuthenticatedContext` — c'est precisement ce qui est
   * verifie, jamais suppose.
   */
  const FORGED_ROLE_HEADERS: Record<string, string> = {
    'X-Roles': 'ADMIN_ETABLISSEMENT,SUPER_ADMIN',
    'X-Role': 'SUPER_ADMIN',
    'X-User-Role': 'SUPER_ADMIN',
    'X-Platform-Role': 'SUPER_ADMIN',
    'X-Permissions': 'audit:read,platform-audit:read',
    'X-Permission-Codes': 'audit:read',
    'X-Role-Codes': 'ADMIN_ETABLISSEMENT',
    'X-Session-Kind': 'PLATFORM',
    'X-Mfa-Satisfied-At': new Date().toISOString(),
  };

  beforeAll(async () => {
    root = buildCompositionRoot();
    handle = await startTestServer(createApp(root));
    sessionStore = new RedisSessionStore(root.redis);

    const now = new Date();
    const standardSession: TenantSessionContext = {
      sessionId: sessionStandard,
      kind: 'TENANT',
      userId,
      tenantId,
      membershipId: randomUUID(),
      // Role standard du catalogue systeme (SystemRoleCatalog.ts) : ni `audit:read`, ni statut
      // plateforme. Toute elevation tentee ci-dessous viserait a franchir CET ecart.
      roleCodes: ['ACCUEIL'],
      permissionCodes: ['patient:read', 'patient:write', 'appointment:read', 'appointment:write'],
      requiresMfa: false,
      mfaSatisfiedAt: null,
      issuedAt: now.toISOString(),
      sensitivityCategory: 'TENANT_STANDARD',
      absoluteExpiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    };
    await sessionStore.create(standardSession);
  });

  afterAll(async () => {
    await sessionStore.delete(sessionStandard);
    await handle.close();
    await root.shutdown();
  });

  it(
    'REFERENCE — session ACCUEIL (sans audit:read), aucune tentative de forge : GET /api/v1/audit-entries -> 403 forbidden, ' +
      'aucune entree exposee (sans ce point de reference, tous les cas ci-dessous seraient faussement verts)',
    async () => {
      const response = await getRequest(handle.baseUrl, AUDIT_PATH, { headers: bearer(sessionStandard) });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
      expect(response.body).not.toContain('entries');
    },
  );

  it('permission forgee en QUERY STRING (?permissionCodes=audit:read) -> 400 invalid_request, jamais 200 (schema .strict(), champ inconnu REJETE, jamais ignore)', async () => {
    const response = await getRequest(handle.baseUrl, `${AUDIT_PATH}?permissionCodes=audit%3Aread`, {
      headers: bearer(sessionStandard),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
    expect(response.body).not.toContain('entries');
  });

  it('role forge en QUERY STRING (?roleCodes=ADMIN_ETABLISSEMENT&role=SUPER_ADMIN) -> 400 invalid_request, jamais 200', async () => {
    const response = await getRequest(handle.baseUrl, `${AUDIT_PATH}?roleCodes=ADMIN_ETABLISSEMENT&role=SUPER_ADMIN`, {
      headers: bearer(sessionStandard),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
    expect(response.body).not.toContain('entries');
  });

  it(
    'role/permission forges en EN-TETES HTTP (X-Roles, X-Platform-Role, X-Permissions, X-Session-Kind...) -> ' +
      "403 forbidden INCHANGE : le role effectif reste celui de la session, aucun en-tete n'alimente la decision",
    async () => {
      const response = await getRequest(handle.baseUrl, AUDIT_PATH, {
        headers: { ...bearer(sessionStandard), ...FORGED_ROLE_HEADERS },
      });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
      expect(response.body).not.toContain('entries');
    },
  );

  it(
    'elevation forgee dans le CORPS JSON du break-glass SUPER_ADMIN (platformRole/roleCodes/permissionCodes/kind/mfaSatisfiedAt) -> ' +
      '400 invalid_request, jamais 201 (anti mass-assignment : le corps ne porte QUE subjectUserAccountId + reason)',
    async () => {
      const response = await postJson(
        handle.baseUrl,
        BREAK_GLASS_PATH,
        {
          subjectUserAccountId: randomUUID(),
          reason: 'tentative d_elevation de privilege par champ additionnel dans le corps JSON',
          platformRole: 'SUPER_ADMIN',
          roleCodes: ['SUPER_ADMIN', 'ADMIN_ETABLISSEMENT'],
          permissionCodes: ['platform-audit:read', 'user-account:administer'],
          kind: 'PLATFORM',
          mfaSatisfiedAt: new Date().toISOString(),
        },
        { headers: bearer(sessionStandard) },
      );
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
      expect(response.body).not.toContain('requestId');
    },
  );

  it(
    'pollution de prototype visant roleCodes/platformRole (`__proto__` dans le corps JSON du break-glass) -> ' +
      '400 invalid_request, jamais 201 (`__proto__` issu de JSON.parse est une cle PROPRE, donc vue et rejetee par .strict())',
    async () => {
      const response = await postRaw(
        handle.baseUrl,
        BREAK_GLASS_PATH,
        JSON.stringify({
          subjectUserAccountId: randomUUID(),
          reason: 'tentative d_elevation de privilege par pollution de prototype',
          ['__proto__']: { roleCodes: ['SUPER_ADMIN'], platformRole: 'SUPER_ADMIN' },
        }),
        { headers: bearer(sessionStandard) },
      );
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
      expect(response.body).not.toContain('requestId');
      // Le prototype du processus de test ET celui du serveur restent intacts : aucun objet ne
      // « herite » d'un role injecte (verification locale — un echec ici signalerait une pollution
      // reelle, quel que soit le code de reponse HTTP).
      expect(({} as Record<string, unknown>)['roleCodes']).toBeUndefined();
    },
  );

  it(
    "role forge dans le CORPS JSON de l'APPROBATION break-glass (corps attendu : objet VIDE) -> 400 invalid_request, jamais 200",
    async () => {
      const response = await postJson(
        handle.baseUrl,
        `${BREAK_GLASS_PATH}/${randomUUID()}/approval`,
        { roleCodes: ['SUPER_ADMIN'], platformRole: 'SUPER_ADMIN' },
        { headers: bearer(sessionStandard) },
      );
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
      expect(response.body).not.toContain('approved');
    },
  );

  it(
    'PREUVE DE FOND — corps JSON PARFAITEMENT VALIDE (aucun champ inconnu a rejeter) + en-tetes de role forges : ' +
      "403 forbidden, et l'entree d'audit DENIED attribue a l'acteur le role REEL de sa session (ACCUEIL), " +
      'jamais le role revendique (SUPER_ADMIN) — le role effectif est lu de la session, jamais de la requete',
    async () => {
      const tenant = TenantId.create(tenantId).getValue();
      const filter = { categories: ['MFA'] as const, eventTypes: ['SUPER_ADMIN_BREAK_GLASS_REQUESTED'] as const };
      const before = await root.audit.repositories.auditEntries.listForTenant(tenant, filter, { cursor: null, limit: 200 });

      const response = await postJson(
        handle.baseUrl,
        BREAK_GLASS_PATH,
        {
          subjectUserAccountId: randomUUID(),
          reason: 'corps valide, elevation tentee uniquement par en-tetes forges',
        },
        { headers: { ...bearer(sessionStandard), ...FORGED_ROLE_HEADERS } },
      );
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
      expect(response.body).not.toContain('requestId');

      const after = await root.audit.repositories.auditEntries.listForTenant(tenant, filter, { cursor: null, limit: 200 });
      expect(after.entries).toHaveLength(before.entries.length + 1);
      const beforeIds = new Set(before.entries.map((entry) => entry.id.toString()));
      const newEntry = after.entries.find((entry) => !beforeIds.has(entry.id.toString()));
      expect(newEntry).toBeDefined();
      expect(newEntry?.outcome).toBe('DENIED');
      expect(newEntry?.actorUserId).toBe(userId);
      expect(newEntry?.tenantId).toBe(tenantId);
      // Le coeur du constat : le role journalise EST celui de la session, jamais celui revendique.
      expect(newEntry?.actorRoleCodes).toEqual(['ACCUEIL']);
      expect(newEntry?.actorRoleCodes).not.toContain('SUPER_ADMIN');
      expect(newEntry?.actorRoleCodes).not.toContain('ADMIN_ETABLISSEMENT');
    },
  );
});
