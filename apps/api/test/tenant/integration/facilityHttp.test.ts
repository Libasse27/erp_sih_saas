import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { RedisSessionStore } from '../../../src/modules/identity/infrastructure/session/RedisSessionStore.js';
import type { PlatformSessionContext, TenantSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { getRequest, patchJson, bearer, startTestServer, type TestServerHandle } from '../../server/httpTestClient.js';
import { createRawPgClient, uniqueFacilityName } from './dbTestHelpers.js';

const FACILITY_PATH = '/api/v1/facility';

/**
 * Integration reelle (PostgreSQL + Redis, bout en bout via le VRAI `CompositionRoot`/`createApp`)
 * de `GET /api/v1/facility` / `PATCH /api/v1/facility` — Phase 1, premier increment vertical
 * (permission `tenant-config:administer`). Meme pattern que
 * `test/identity/integration/superAdminBreakGlassHttp.test.ts` : sessions plantees DIRECTEMENT
 * dans Redis via `RedisSessionStore` (leur existence en tant que `UserAccount` n'est jamais
 * verifiee par ces deux handlers), `HealthFacility` REELLEMENT insere en Postgres (bypass
 * applicatif, comme `rls.test.ts`).
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('GET/PATCH /api/v1/facility — integration reelle (Phase 1, tenant-config:administer)', () => {
  let root: CompositionRoot;
  let handle: TestServerHandle;
  let sessionStore: RedisSessionStore;
  let rawClient: Client;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();

  const sessionAdmin = randomUUID();
  const sessionNoPermission = randomUUID();
  const sessionPlatform = randomUUID();

  const adminActorId = randomUUID();
  const noPermissionActorId = randomUUID();
  const platformActorId = randomUUID();

  const originalFacilityName = uniqueFacilityName('Etablissement HTTP');

  beforeAll(async () => {
    root = buildCompositionRoot();
    const app = createApp(root);
    handle = await startTestServer(app);

    sessionStore = new RedisSessionStore(root.redis);
    rawClient = await createRawPgClient();

    // HealthFacility REEL, insere par bypass applicatif (meme discipline que rls.test.ts) : ce
    // fichier ne teste pas la Saga de provisioning, seulement les deux nouvelles routes.
    await rawClient.query('BEGIN');
    await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await rawClient.query(
      `INSERT INTO "HealthFacility" (id, tenant_id, name, status, created_at) VALUES ($1, $1, $2, 'ACTIVE', now())`,
      [tenantId, originalFacilityName],
    );
    await rawClient.query('COMMIT');
    await rawClient.query('BEGIN');
    await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [otherTenantId]);
    await rawClient.query(
      `INSERT INTO "HealthFacility" (id, tenant_id, name, status, created_at) VALUES ($1, $1, $2, 'ACTIVE', now())`,
      [otherTenantId, uniqueFacilityName('Etablissement HTTP Autre Tenant')],
    );
    await rawClient.query('COMMIT');

    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const adminSession: TenantSessionContext = {
      sessionId: sessionAdmin,
      kind: 'TENANT',
      userId: adminActorId,
      tenantId,
      membershipId: randomUUID(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['tenant-config:administer'],
      requiresMfa: false,
      mfaSatisfiedAt: null,
      issuedAt: now.toISOString(),
      sensitivityCategory: 'TENANT_STANDARD',
      absoluteExpiresAt,
    };
    await sessionStore.create(adminSession);

    const noPermissionSession: TenantSessionContext = {
      sessionId: sessionNoPermission,
      kind: 'TENANT',
      userId: noPermissionActorId,
      tenantId,
      membershipId: randomUUID(),
      roleCodes: ['CAISSIER'],
      permissionCodes: ['cash-register:open'],
      requiresMfa: false,
      mfaSatisfiedAt: null,
      issuedAt: now.toISOString(),
      sensitivityCategory: 'TENANT_STANDARD',
      absoluteExpiresAt,
    };
    await sessionStore.create(noPermissionSession);

    const platformSession: PlatformSessionContext = {
      sessionId: sessionPlatform,
      kind: 'PLATFORM',
      userId: platformActorId,
      requiresMfa: true,
      mfaSatisfiedAt: now.toISOString(),
      issuedAt: now.toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt,
    };
    await sessionStore.create(platformSession);
  });

  afterAll(async () => {
    await sessionStore.delete(sessionAdmin);
    await sessionStore.delete(sessionNoPermission);
    await sessionStore.delete(sessionPlatform);
    for (const id of [tenantId, otherTenantId]) {
      await rawClient.query('BEGIN');
      await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
      await rawClient.query('DELETE FROM "HealthFacility" WHERE id = $1', [id]);
      await rawClient.query('COMMIT');
    }
    await rawClient.end();
    await handle.close();
    await root.shutdown();
  });

  /**
   * Lecture de verification SOUS RLS FORCE (meme discipline que rls.test.ts) : `HealthFacility`
   * n'est JAMAIS lisible sans `app.tenant_id` positionne dans la MEME transaction — une lecture
   * "nue" (sans `BEGIN`/`set_config`) ne verrait STRUCTURELLEMENT aucune ligne, quel que soit
   * l'identifiant recherche.
   */
  async function readFacilityName(id: string): Promise<string | undefined> {
    await rawClient.query('BEGIN');
    try {
      await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
      const result = await rawClient.query<{ name: string }>('SELECT name FROM "HealthFacility" WHERE id = $1', [id]);
      return result.rows[0]?.name;
    } finally {
      await rawClient.query('COMMIT');
    }
  }

  async function findLatestAuditEntry(
    actorUserId: string,
  ): Promise<{ outcome: string; tenant_id: string | null; actor_kind: string; target_id: string | null } | undefined> {
    const result = await rawClient.query<{ outcome: string; tenant_id: string | null; actor_kind: string; target_id: string | null }>(
      `SELECT outcome, tenant_id, actor_kind, target_id FROM "platform"."AuditEntry"
       WHERE event_type = 'TENANT_CONFIG_FACILITY_RENAMED' AND actor_user_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [actorUserId],
    );
    return result.rows[0];
  }

  it('GET sans en-tete Authorization -> 401', async () => {
    const response = await getRequest(handle.baseUrl, FACILITY_PATH);
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthenticated' });
  });

  it('PATCH sans en-tete Authorization -> 401', async () => {
    const response = await patchJson(handle.baseUrl, FACILITY_PATH, { name: 'Peu importe' });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthenticated' });
  });

  it('GET avec une session TENANT SANS tenant-config:administer -> 403 forbidden', async () => {
    const response = await getRequest(handle.baseUrl, FACILITY_PATH, { headers: bearer(sessionNoPermission) });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
  });

  it(
    'PATCH avec une session TENANT SANS tenant-config:administer -> 403 forbidden, refus AUDITE (DENIED) ET COMMIT ' +
      '(ADR-0005 Amendement 3 : controle + audit DENIED dans la transaction)',
    async () => {
      const response = await patchJson(
        handle.baseUrl,
        FACILITY_PATH,
        { name: 'Tentative Sans Permission' },
        { headers: bearer(sessionNoPermission) },
      );
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });

      const entry = await findLatestAuditEntry(noPermissionActorId);
      expect(entry?.outcome).toBe('DENIED');
      expect(entry?.tenant_id).toBe(tenantId);
      expect(entry?.actor_kind).toBe('USER_TENANT');

      // Aucune mutation : le nom d'origine reste inchange.
      expect(await readFacilityName(tenantId)).toBe(originalFacilityName);
    },
  );

  it('GET avec une session PLATFORM -> 403 forbidden (branche explicite, jamais un fallthrough)', async () => {
    const response = await getRequest(handle.baseUrl, FACILITY_PATH, { headers: bearer(sessionPlatform) });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
  });

  it(
    'PATCH avec une session PLATFORM -> 403 forbidden (tenant-config:administer est une permission TENANT, jamais PLATFORM), ' +
      'refus AUDITE (DENIED, tenantId NULL) ET COMMIT',
    async () => {
      const response = await patchJson(
        handle.baseUrl,
        FACILITY_PATH,
        { name: 'Tentative Plateforme' },
        { headers: bearer(sessionPlatform) },
      );
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });

      const entry = await findLatestAuditEntry(platformActorId);
      expect(entry?.outcome).toBe('DENIED');
      expect(entry?.tenant_id).toBeNull();
      expect(entry?.actor_kind).toBe('USER_PLATFORM');
      expect(entry?.target_id).toBeNull();
    },
  );

  it('PATCH avec un tenantId/role forge dans le corps -> 400 invalid_request (schema .strict(), mass-assignment rejete)', async () => {
    const response = await patchJson(
      handle.baseUrl,
      FACILITY_PATH,
      { name: 'Nom Valide', tenantId: otherTenantId, role: 'SUPER_ADMIN' },
      { headers: bearer(sessionAdmin) },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });

    // Ni la ligne du tenant courant, ni celle de l'autre tenant vise par le champ forge, n'ont ete
    // touchees.
    expect(await readFacilityName(tenantId)).toBe(originalFacilityName);
  });

  it('GET avec une session TENANT autorisee -> 200, identite du HealthFacility du tenant courant', async () => {
    const response = await getRequest(handle.baseUrl, FACILITY_PATH, { headers: bearer(sessionAdmin) });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { tenantId: string; name: string; status: string };
    expect(body.tenantId).toBe(tenantId);
    expect(body.name).toBe(originalFacilityName);
    expect(body.status).toBe('ACTIVE');
  });

  it(
    'PATCH avec une session TENANT autorisee -> 200, renommage effectif, SUCCES AUDITE ET COMMIT ' +
      '(interroge platform.AuditEntry)',
    async () => {
      const newName = uniqueFacilityName('Etablissement HTTP Renomme');
      const response = await patchJson(handle.baseUrl, FACILITY_PATH, { name: newName }, { headers: bearer(sessionAdmin) });

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as { tenantId: string; name: string; status: string };
      expect(body.tenantId).toBe(tenantId);
      expect(body.name).toBe(newName);

      expect(await readFacilityName(tenantId)).toBe(newName);

      const entry = await findLatestAuditEntry(adminActorId);
      expect(entry?.outcome).toBe('SUCCESS');
      expect(entry?.tenant_id).toBe(tenantId);
      expect(entry?.actor_kind).toBe('USER_TENANT');
      expect(entry?.target_id).toBe(tenantId);
    },
  );

  it('PATCH un renommage vers le nom DEJA courant -> 409 conflict (NAME_UNCHANGED), refus audite en FAILURE', async () => {
    const currentName = (await readFacilityName(tenantId)) ?? '';

    const response = await patchJson(handle.baseUrl, FACILITY_PATH, { name: currentName }, { headers: bearer(sessionAdmin) });

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: 'conflict' });

    const entry = await findLatestAuditEntry(adminActorId);
    expect(entry?.outcome).toBe('FAILURE');
  });

  it('PATCH avec un corps vide -> 400 invalid_request', async () => {
    const response = await patchJson(handle.baseUrl, FACILITY_PATH, {}, { headers: bearer(sessionAdmin) });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });
});
