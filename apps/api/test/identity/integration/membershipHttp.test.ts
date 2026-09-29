import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { RedisSessionStore } from '../../../src/modules/identity/infrastructure/session/RedisSessionStore.js';
import type { PlatformSessionContext, TenantSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import { getRequest, bearer, startTestServer, type TestServerHandle } from '../../server/httpTestClient.js';
import { createRawPgClient, uniqueEmail } from './dbTestHelpers.js';

const MEMBERSHIPS_PATH = '/api/v1/memberships';

interface MembershipDtoShape {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly roleCodes: readonly string[];
  readonly status: string;
  readonly joinedAt: string;
  readonly leftAt: string | null;
}

/**
 * Integration reelle (PostgreSQL + Redis, bout en bout via le VRAI `CompositionRoot`/`createApp`)
 * de `GET /api/v1/memberships` — Phase 1, deuxieme increment vertical (permission
 * `membership:administer`). MEME PATTERN que `test/tenant/integration/facilityHttp.test.ts` :
 * sessions plantees DIRECTEMENT dans Redis via `RedisSessionStore` (leur existence en tant que
 * `UserAccount` n'est jamais verifiee par ce handler), memberships REELLEMENT octroyes via les
 * VRAIS handlers Identity (`createUserAccount`/`grantMembership`) — c'est precisement ce que ce
 * handler lit.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('GET /api/v1/memberships — integration reelle (Phase 1, membership:administer)', () => {
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

  let memberOneUserId: string;
  let memberOneEmail: string;
  let memberTwoUserId: string;
  let otherTenantUserId: string;
  const userIdsToCleanup: string[] = [];

  beforeAll(async () => {
    root = buildCompositionRoot();
    const app = createApp(root);
    handle = await startTestServer(app);

    sessionStore = new RedisSessionStore(root.redis);
    rawClient = await createRawPgClient();

    await seedPermissionCatalog(root.prisma);
    await seedSystemRoles(root.identity.repositories.roles);

    async function createAccount(prefix: string): Promise<string> {
      const result = await root.identity.handlers.createUserAccount.execute({
        email: uniqueEmail(prefix),
        plainPassword: 'mot-de-passe-suffisant-1',
        platformRole: 'NONE',
      });
      if (result.isFailure()) {
        throw new Error(`setup: creation compte (${prefix}) echouee : ${String(result.getError())}`);
      }
      const userId = result.getValue().userAccountId;
      userIdsToCleanup.push(userId);
      return userId;
    }

    memberOneEmail = uniqueEmail('membre-un');
    const accountOneResult = await root.identity.handlers.createUserAccount.execute({
      email: memberOneEmail,
      plainPassword: 'mot-de-passe-suffisant-1',
      platformRole: 'NONE',
    });
    if (accountOneResult.isFailure()) {
      throw new Error('setup: creation compte 1 echouee');
    }
    memberOneUserId = accountOneResult.getValue().userAccountId;
    userIdsToCleanup.push(memberOneUserId);

    memberTwoUserId = await createAccount('membre-deux');
    otherTenantUserId = await createAccount('membre-autre-tenant');

    const grantOne = await root.identity.handlers.grantMembership.execute({
      userId: memberOneUserId,
      tenantId,
      createdBy: memberOneUserId,
      initialRoleCodes: ['MEDECIN'],
    });
    if (grantOne.isFailure()) {
      throw new Error(`setup: octroi membership 1 echoue : ${String(grantOne.getError())}`);
    }

    const grantTwo = await root.identity.handlers.grantMembership.execute({
      userId: memberTwoUserId,
      tenantId,
      createdBy: memberOneUserId,
      initialRoleCodes: ['CAISSIER'],
    });
    if (grantTwo.isFailure()) {
      throw new Error(`setup: octroi membership 2 echoue : ${String(grantTwo.getError())}`);
    }

    // Membership d'un AUTRE tenant — complementaire de listTenantMembershipsRls.test.ts (qui
    // prouve la meme propriete au niveau repository/RLS) : prouve ICI, cote HTTP, l'absence de
    // fuite entre etablissements.
    const otherGrant = await root.identity.handlers.grantMembership.execute({
      userId: otherTenantUserId,
      tenantId: otherTenantId,
      createdBy: otherTenantUserId,
      initialRoleCodes: ['ACCUEIL'],
    });
    if (otherGrant.isFailure()) {
      throw new Error(`setup: octroi membership autre tenant echoue : ${String(otherGrant.getError())}`);
    }

    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const adminSession: TenantSessionContext = {
      sessionId: sessionAdmin,
      kind: 'TENANT',
      userId: adminActorId,
      tenantId,
      membershipId: randomUUID(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['membership:administer'],
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
      await rawClient.query('DELETE FROM "MembershipRole" WHERE tenant_id = $1', [id]);
      await rawClient.query('DELETE FROM "UserTenantMembership" WHERE tenant_id = $1', [id]);
      await rawClient.query('COMMIT');
    }
    if (userIdsToCleanup.length > 0) {
      await rawClient.query('DELETE FROM "platform"."UserAccount" WHERE id = ANY($1)', [userIdsToCleanup]);
    }
    await rawClient.end();
    await handle.close();
    await root.shutdown();
  });

  it('sans en-tete Authorization -> 401', async () => {
    const response = await getRequest(handle.baseUrl, MEMBERSHIPS_PATH);
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthenticated' });
  });

  it('session TENANT SANS membership:administer -> 403 forbidden', async () => {
    const response = await getRequest(handle.baseUrl, MEMBERSHIPS_PATH, { headers: bearer(sessionNoPermission) });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
  });

  it('session PLATFORM -> 403 forbidden (branche explicite, jamais un fallthrough)', async () => {
    const response = await getRequest(handle.baseUrl, MEMBERSHIPS_PATH, { headers: bearer(sessionPlatform) });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
  });

  it('session TENANT autorisee -> 200, liste des memberships du tenant courant UNIQUEMENT (jamais ceux d_un autre tenant)', async () => {
    const response = await getRequest(handle.baseUrl, MEMBERSHIPS_PATH, { headers: bearer(sessionAdmin) });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { memberships: MembershipDtoShape[]; nextCursor: string | null };

    expect(body.memberships).toHaveLength(2);
    expect(body.memberships.some((m) => m.userId === otherTenantUserId)).toBe(false);

    const memberOne = body.memberships.find((m) => m.userId === memberOneUserId);
    expect(memberOne).toBeDefined();
    expect(memberOne?.email).toBe(memberOneEmail);
    expect(memberOne?.roleCodes).toEqual(['MEDECIN']);
    expect(memberOne?.status).toBe('ACTIVE');
    expect(memberOne?.leftAt).toBeNull();
    expect(typeof memberOne?.joinedAt).toBe('string');

    const memberTwo = body.memberships.find((m) => m.userId === memberTwoUserId);
    expect(memberTwo?.roleCodes).toEqual(['CAISSIER']);
  });

  it('filtre status=REVOKED -> liste vide (aucun membership revoque dans ce tenant)', async () => {
    const response = await getRequest(handle.baseUrl, `${MEMBERSHIPS_PATH}?status=REVOKED`, { headers: bearer(sessionAdmin) });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { memberships: MembershipDtoShape[]; nextCursor: string | null };
    expect(body.memberships).toHaveLength(0);
    expect(body.nextCursor).toBeNull();
  });

  it('filtre status=ACTIVE -> les deux memberships du tenant', async () => {
    const response = await getRequest(handle.baseUrl, `${MEMBERSHIPS_PATH}?status=ACTIVE`, { headers: bearer(sessionAdmin) });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { memberships: MembershipDtoShape[]; nextCursor: string | null };
    expect(body.memberships).toHaveLength(2);
  });

  it('limit=0 (hors bornes) -> 400 invalid_request, jamais un plafonnement silencieux', async () => {
    const response = await getRequest(handle.baseUrl, `${MEMBERSHIPS_PATH}?limit=0`, { headers: bearer(sessionAdmin) });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('limit=201 (hors bornes) -> 400 invalid_request, jamais un plafonnement silencieux', async () => {
    const response = await getRequest(handle.baseUrl, `${MEMBERSHIPS_PATH}?limit=201`, { headers: bearer(sessionAdmin) });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('parametre inconnu dans la query (mass-assignment, ex. tenantId force) -> 400 invalid_request (schema .strict())', async () => {
    const response = await getRequest(handle.baseUrl, `${MEMBERSHIPS_PATH}?tenantId=${otherTenantId}`, {
      headers: bearer(sessionAdmin),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('curseur malforme -> 400 invalid_request', async () => {
    const response = await getRequest(handle.baseUrl, `${MEMBERSHIPS_PATH}?cursor=pas-du-tout-un-curseur-valide`, {
      headers: bearer(sessionAdmin),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('limit=1 -> une seule page a la fois, nextCursor non nul, la deuxieme page complete la liste', async () => {
    const firstResponse = await getRequest(handle.baseUrl, `${MEMBERSHIPS_PATH}?limit=1`, { headers: bearer(sessionAdmin) });
    expect(firstResponse.status).toBe(200);
    const firstBody = JSON.parse(firstResponse.body) as { memberships: MembershipDtoShape[]; nextCursor: string | null };
    expect(firstBody.memberships).toHaveLength(1);
    expect(firstBody.nextCursor).not.toBeNull();

    const secondResponse = await getRequest(
      handle.baseUrl,
      `${MEMBERSHIPS_PATH}?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      { headers: bearer(sessionAdmin) },
    );
    expect(secondResponse.status).toBe(200);
    const secondBody = JSON.parse(secondResponse.body) as { memberships: MembershipDtoShape[]; nextCursor: string | null };
    expect(secondBody.memberships).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();

    const seenUserIds = [firstBody.memberships[0]?.userId, secondBody.memberships[0]?.userId];
    expect(seenUserIds).toContain(memberOneUserId);
    expect(seenUserIds).toContain(memberTwoUserId);
  });
});
