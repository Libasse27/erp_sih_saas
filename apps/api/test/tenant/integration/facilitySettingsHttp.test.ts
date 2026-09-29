import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { RedisSessionStore } from '../../../src/modules/identity/infrastructure/session/RedisSessionStore.js';
import type { PlatformSessionContext, TenantSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { getRequest, bearer, startTestServer, type TestServerHandle } from '../../server/httpTestClient.js';
import { createRawPgClient } from './dbTestHelpers.js';

const FACILITY_SETTINGS_PATH = '/api/v1/facility-settings';

/**
 * Integration reelle (PostgreSQL + Redis, bout en bout via le VRAI `CompositionRoot`/`createApp`)
 * de `GET /api/v1/facility-settings` — Phase 1, troisieme increment vertical, MEME permission
 * `tenant-config:administer` que `/api/v1/facility` (aucune nouvelle permission). Meme pattern que
 * `facilityHttp.test.ts` : sessions plantees DIRECTEMENT dans Redis, `FacilitySettings` REELLEMENT
 * insere en Postgres (bypass applicatif).
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('GET /api/v1/facility-settings — integration reelle (Phase 1, tenant-config:administer)', () => {
  let root: CompositionRoot;
  let handle: TestServerHandle;
  let sessionStore: RedisSessionStore;
  let rawClient: Client;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const orphanTenantId = randomUUID();

  const sessionAdmin = randomUUID();
  const sessionOtherAdmin = randomUUID();
  const sessionNoPermission = randomUUID();
  const sessionPlatform = randomUUID();

  const adminActorId = randomUUID();
  const otherAdminActorId = randomUUID();
  const noPermissionActorId = randomUUID();
  const platformActorId = randomUUID();

  beforeAll(async () => {
    root = buildCompositionRoot();
    const app = createApp(root);
    handle = await startTestServer(app);

    sessionStore = new RedisSessionStore(root.redis);
    rawClient = await createRawPgClient();

    // FacilitySettings REEL, insere par bypass applicatif (meme discipline que facilityHttp.test.ts).
    // DEUX tenants distincts recoivent chacun leur PROPRE ligne, avec des valeurs DIFFERENTES —
    // condition necessaire pour qu'un eventuel defaut d'isolation soit detectable par un test qui
    // interroge la route elle-meme (pas seulement la politique RLS brute, deja couverte par
    // rls.test.ts). `orphanTenantId` reste volontairement SANS FacilitySettings, pour le cas
    // defensif 404.
    await rawClient.query('BEGIN');
    await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await rawClient.query(
      `INSERT INTO "FacilitySettings" (id, tenant_id, locale, timezone, currency, phone_country_code, created_at)
       VALUES ($1, $1, 'fr-SN', 'Africa/Dakar', 'XOF', '+221', now())`,
      [tenantId],
    );
    await rawClient.query('COMMIT');
    await rawClient.query('BEGIN');
    await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [otherTenantId]);
    await rawClient.query(
      `INSERT INTO "FacilitySettings" (id, tenant_id, locale, timezone, currency, phone_country_code, created_at)
       VALUES ($1, $1, 'en-US', 'America/New_York', 'USD', '+1', now())`,
      [otherTenantId],
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

    const otherAdminSession: TenantSessionContext = {
      sessionId: sessionOtherAdmin,
      kind: 'TENANT',
      userId: otherAdminActorId,
      tenantId: otherTenantId,
      membershipId: randomUUID(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['tenant-config:administer'],
      requiresMfa: false,
      mfaSatisfiedAt: null,
      issuedAt: now.toISOString(),
      sensitivityCategory: 'TENANT_STANDARD',
      absoluteExpiresAt,
    };
    await sessionStore.create(otherAdminSession);

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
    await sessionStore.delete(sessionOtherAdmin);
    await sessionStore.delete(sessionNoPermission);
    await sessionStore.delete(sessionPlatform);
    for (const id of [tenantId, otherTenantId]) {
      await rawClient.query('BEGIN');
      await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [id]);
      await rawClient.query('DELETE FROM "FacilitySettings" WHERE id = $1', [id]);
      await rawClient.query('COMMIT');
    }
    await rawClient.end();
    await handle.close();
    await root.shutdown();
  });

  it('GET sans en-tete Authorization -> 401', async () => {
    const response = await getRequest(handle.baseUrl, FACILITY_SETTINGS_PATH);
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthenticated' });
  });

  it('GET avec une session TENANT SANS tenant-config:administer -> 403 forbidden', async () => {
    const response = await getRequest(handle.baseUrl, FACILITY_SETTINGS_PATH, { headers: bearer(sessionNoPermission) });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
  });

  it('GET avec une session PLATFORM -> 403 forbidden (branche explicite, jamais un fallthrough)', async () => {
    const response = await getRequest(handle.baseUrl, FACILITY_SETTINGS_PATH, { headers: bearer(sessionPlatform) });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
  });

  it('GET avec une session TENANT autorisee -> 200, parametres regionaux du tenant courant', async () => {
    const response = await getRequest(handle.baseUrl, FACILITY_SETTINGS_PATH, { headers: bearer(sessionAdmin) });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      tenantId: string;
      locale: string;
      timezone: string;
      currency: string;
      phoneCountryCode: string;
    };
    expect(body.tenantId).toBe(tenantId);
    expect(body.locale).toBe('fr-SN');
    expect(body.timezone).toBe('Africa/Dakar');
    expect(body.currency).toBe('XOF');
    expect(body.phoneCountryCode).toBe('+221');
  });

  it(
    'GET ne fuit JAMAIS les parametres d_un AUTRE tenant : deux tenants avec des FacilitySettings ' +
      'distincts, chaque session TENANT ne voit que les siens (preuve sur la route elle-meme, pas ' +
      'seulement sur la politique RLS brute deja couverte par rls.test.ts)',
    async () => {
      const responseTenant = await getRequest(handle.baseUrl, FACILITY_SETTINGS_PATH, { headers: bearer(sessionAdmin) });
      expect(responseTenant.status).toBe(200);
      const bodyTenant = JSON.parse(responseTenant.body) as { tenantId: string; locale: string; currency: string };
      expect(bodyTenant.tenantId).toBe(tenantId);
      expect(bodyTenant.locale).toBe('fr-SN');
      expect(bodyTenant.currency).toBe('XOF');

      const responseOther = await getRequest(handle.baseUrl, FACILITY_SETTINGS_PATH, { headers: bearer(sessionOtherAdmin) });
      expect(responseOther.status).toBe(200);
      const bodyOther = JSON.parse(responseOther.body) as { tenantId: string; locale: string; currency: string };
      expect(bodyOther.tenantId).toBe(otherTenantId);
      expect(bodyOther.locale).toBe('en-US');
      expect(bodyOther.currency).toBe('USD');

      // Non-fuite explicite dans les deux sens.
      expect(bodyTenant.tenantId).not.toBe(otherTenantId);
      expect(bodyOther.tenantId).not.toBe(tenantId);
    },
  );

  it('GET avec ?tenantId=... force dans la query -> 400 invalid_request (schema .strict(), mass-assignment rejete, jamais ignore silencieusement)', async () => {
    const response = await getRequest(handle.baseUrl, `${FACILITY_SETTINGS_PATH}?tenantId=${otherTenantId}`, {
      headers: bearer(sessionAdmin),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('GET avec ?role=... force dans la query -> 400 invalid_request (schema .strict())', async () => {
    const response = await getRequest(handle.baseUrl, `${FACILITY_SETTINGS_PATH}?role=SUPER_ADMIN`, {
      headers: bearer(sessionAdmin),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('GET pour un tenant sans FacilitySettings -> 404 not_found (defensif)', async () => {
    const sessionOrphan = randomUUID();
    const orphanActorId = randomUUID();
    const now = new Date();
    const orphanSession: TenantSessionContext = {
      sessionId: sessionOrphan,
      kind: 'TENANT',
      userId: orphanActorId,
      tenantId: orphanTenantId,
      membershipId: randomUUID(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['tenant-config:administer'],
      requiresMfa: false,
      mfaSatisfiedAt: null,
      issuedAt: now.toISOString(),
      sensitivityCategory: 'TENANT_STANDARD',
      absoluteExpiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    };
    await sessionStore.create(orphanSession);
    try {
      const response = await getRequest(handle.baseUrl, FACILITY_SETTINGS_PATH, { headers: bearer(sessionOrphan) });
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({ error: 'not_found' });
    } finally {
      await sessionStore.delete(sessionOrphan);
    }
  });
});
