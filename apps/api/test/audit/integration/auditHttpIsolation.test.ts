import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { RedisSessionStore } from '../../../src/modules/identity/infrastructure/session/RedisSessionStore.js';
import type { PlatformSessionContext, MfaPendingSessionContext, TenantSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';

/**
 * Isolation inter-tenant — niveau HTTP (ADR-0009 §10, troisieme et dernier des trois niveaux de
 * garde-fou exiges par le responsable technique ; niveaux REPOSITORY/QUERY HANDLERS couverts par
 * auditEntryTenantIsolation.test.ts/auditQueryIsolation.test.ts).
 *
 * Construit le VRAI `CompositionRoot` (`buildCompositionRoot()` + `createApp()`, src/server.ts) —
 * PREMIER endpoint HTTP authentifie du depot (ADR-0009 §8) : contrairement a la convention
 * "dupliquer plutot qu'importer composition-root.ts" suivie ailleurs dans ce depot pour des
 * adaptateurs cross-module isoles, ce test cible precisement le middleware d'authentification ET
 * le controleur REELS, bout en bout — dupliquer `requireAuthenticatedContext` ici reintroduirait
 * exactement le risque que l'ADR ecarte explicitement (§8.2 : "jamais un second chemin de
 * resolution de contexte"). `startBackgroundJobs()` n'est JAMAIS appele (aucun job de fond
 * necessaire a ce test).
 *
 * Sessions plantees DIRECTEMENT dans Redis via `RedisSessionStore` (meme pattern que
 * test/identity/integration/mfaSessionGate.test.ts) — plus rapide et plus cible qu'un parcours
 * `AuthenticateUser`/`ResolveTenantContext` complet, qui n'apporterait rien de plus ici (ce test
 * exerce l'ISOLATION de l'endpoint d'audit, pas le flux d'authentification lui-meme, deja couvert
 * ailleurs).
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('GET /api/v1/audit-entries — isolation inter-tenant, niveau HTTP (ADR-0009 §8/§10)', () => {
  let root: CompositionRoot;
  let server: http.Server;
  let baseUrl: string;
  let sessionStore: RedisSessionStore;

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  const userAId = randomUUID();
  const userBId = randomUUID();
  const platformUserId = randomUUID();
  const mfaPendingUserId = randomUUID();

  const sessionA = randomUUID();
  const sessionB = randomUUID();
  const sessionPlatform = randomUUID();
  const sessionMfaPending = randomUUID();

  beforeAll(async () => {
    root = buildCompositionRoot();
    const app = createApp(root);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Adresse de serveur de test inattendue.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    sessionStore = new RedisSessionStore(root.redis);

    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const tenantSession = (sessionId: string, userId: string, tenantId: string): TenantSessionContext => ({
      sessionId,
      kind: 'TENANT',
      userId,
      tenantId,
      membershipId: randomUUID(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['audit:read'],
      requiresMfa: false,
      mfaSatisfiedAt: null,
      issuedAt: now.toISOString(),
      sensitivityCategory: 'TENANT_STANDARD',
      absoluteExpiresAt,
    });

    await sessionStore.create(tenantSession(sessionA, userAId, tenantAId));
    await sessionStore.create(tenantSession(sessionB, userBId, tenantBId));

    const platformSession: PlatformSessionContext = {
      sessionId: sessionPlatform,
      kind: 'PLATFORM',
      userId: platformUserId,
      requiresMfa: true,
      mfaSatisfiedAt: now.toISOString(),
      issuedAt: now.toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt,
    };
    await sessionStore.create(platformSession);

    const mfaPendingSession: MfaPendingSessionContext = {
      sessionId: sessionMfaPending,
      kind: 'MFA_PENDING',
      userId: mfaPendingUserId,
      intent: { kind: 'TENANT', tenantId: tenantAId },
      reason: 'CHALLENGE_REQUIRED',
      auditRoleCodes: [],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    };
    await sessionStore.create(mfaPendingSession);

    // Entrees d'audit reelles pour A et B (categorie MFA, deja emise depuis l'etape 7/13) —
    // ecrites DANS une transaction (contrat non negociable de `recordEntry`, ADR-0005 §5/ADR-0009
    // §4), via le `UnitOfWork` PARTAGE (meme instance Prisma que le reste du CompositionRoot,
    // `AsyncLocalStorage` commune a tous les modules — voir PrismaTransactionContext.ts).
    await root.identity.unitOfWork.withTransaction(async () => {
      await root.audit.services.recordEntry({
        category: 'MFA',
        eventType: 'MFA_CHALLENGE_SUCCEEDED',
        outcome: 'SUCCESS',
        tenantId: tenantAId,
        actorKind: 'USER_TENANT',
        actorUserId: userAId,
        actorRoleCodes: [],
        subjectUserId: userAId,
        targetType: 'USER_ACCOUNT',
        targetId: userAId,
        reason: null,
        sessionId: null,
        correlationId: null,
      });
    });
    await root.identity.unitOfWork.withTransaction(async () => {
      await root.audit.services.recordEntry({
        category: 'MFA',
        eventType: 'MFA_CHALLENGE_SUCCEEDED',
        outcome: 'SUCCESS',
        tenantId: tenantBId,
        actorKind: 'USER_TENANT',
        actorUserId: userBId,
        actorRoleCodes: [],
        subjectUserId: userBId,
        targetType: 'USER_ACCOUNT',
        targetId: userBId,
        reason: null,
        sessionId: null,
        correlationId: null,
      });
    });
  });

  afterAll(async () => {
    await sessionStore.delete(sessionA);
    await sessionStore.delete(sessionB);
    await sessionStore.delete(sessionPlatform);
    await sessionStore.delete(sessionMfaPending);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await root.shutdown();
  });

  function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      http
        .get(`${baseUrl}${path}`, { headers }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        })
        .on('error', reject);
    });
  }

  function bearer(sessionId: string): Record<string, string> {
    return { Authorization: `Bearer ${sessionId}` };
  }

  it('aucun en-tete Authorization -> 401, aucune donnee', async () => {
    const response = await get('/api/v1/audit-entries');
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthenticated' });
  });

  it("session MFA_PENDING -> 403 { error: 'mfa_required' }, aucune donnee (aucun ServerContext, aucune transaction — meme garantie que mfaSessionGate.test.ts)", async () => {
    const response = await get('/api/v1/audit-entries', bearer(sessionMfaPending));
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'mfa_required' });
    expect(response.body).not.toContain('entries');
  });

  it('session A + ?tenantId=<B> -> 400, corps ne contenant AUCUNE donnee de B (perimetre rejete, jamais ignore, §8.5)', async () => {
    const response = await get(`/api/v1/audit-entries?tenantId=${tenantBId}`, bearer(sessionA));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
    expect(response.body).not.toContain(tenantBId);
    expect(response.body).not.toContain(userBId);
  });

  it('session A + ?scope=tenant&tenantId=<B> -> 400, corps ne contenant AUCUNE donnee de B', async () => {
    const response = await get(`/api/v1/audit-entries?scope=tenant&tenantId=${tenantBId}`, bearer(sessionA));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
    expect(response.body).not.toContain(tenantBId);
  });

  it('session A + ?scope=all -> 400 (un principal TENANT ne peut fournir AUCUN parametre de perimetre, meme scope=all)', async () => {
    const response = await get('/api/v1/audit-entries?scope=all', bearer(sessionA));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('session A, SANS aucun parametre de perimetre -> 200, ne voit QUE les entrees de A', async () => {
    const response = await get('/api/v1/audit-entries?limit=200', bearer(sessionA));
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as { entries: Array<{ tenantId: string | null; subjectUserId: string | null }> };
    expect(parsed.entries.some((entry) => entry.subjectUserId === userAId)).toBe(true);
    expect(parsed.entries.every((entry) => entry.tenantId === tenantAId)).toBe(true);
    expect(parsed.entries.some((entry) => entry.subjectUserId === userBId)).toBe(false);
  });

  it('session A, avec un jeu de parametres de FILTRE quelconque (category/outcome) -> ne voit TOUJOURS QUE les entrees de A', async () => {
    const response = await get('/api/v1/audit-entries?category=MFA&outcome=SUCCESS&limit=200', bearer(sessionA));
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as { entries: Array<{ tenantId: string | null }> };
    expect(parsed.entries.every((entry) => entry.tenantId === tenantAId)).toBe(true);
  });

  it('session B, symetrique : ne voit QUE les entrees de B, jamais celles de A', async () => {
    const response = await get('/api/v1/audit-entries?limit=200', bearer(sessionB));
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as { entries: Array<{ tenantId: string | null; subjectUserId: string | null }> };
    expect(parsed.entries.some((entry) => entry.subjectUserId === userBId)).toBe(true);
    expect(parsed.entries.every((entry) => entry.tenantId === tenantBId)).toBe(true);
  });

  it('session PLATFORM + ?scope=tenant&tenantId=<B> -> 200, voit les donnees de B (perimetre tenant arbitraire, decision confirmee)', async () => {
    const response = await get(`/api/v1/audit-entries?scope=tenant&tenantId=${tenantBId}&limit=200`, bearer(sessionPlatform));
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as { entries: Array<{ tenantId: string | null; subjectUserId: string | null }> };
    expect(parsed.entries.some((entry) => entry.subjectUserId === userBId)).toBe(true);
  });

  it('session PLATFORM + ?scope=tenant&tenantId=<A> -> 200, voit AUSSI les donnees de A (meme session, perimetre arbitraire different)', async () => {
    const response = await get(`/api/v1/audit-entries?scope=tenant&tenantId=${tenantAId}&limit=200`, bearer(sessionPlatform));
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as { entries: Array<{ tenantId: string | null; subjectUserId: string | null }> };
    expect(parsed.entries.some((entry) => entry.subjectUserId === userAId)).toBe(true);
  });
});
