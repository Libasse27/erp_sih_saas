import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../src/shared-kernel/application/OutboxEventHandler.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import { seedPlanCatalog } from '../../../src/modules/subscription/infrastructure/SubscriptionModule.js';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { bearer, getRequest, nextLoopbackIp, postJson, startTestServer, type TestServerHandle } from '../../server/httpTestClient.js';
import { uniqueEmail, uniqueFacilityName } from './dbTestHelpers.js';

const OWNER_PASSWORD = 'mot-de-passe-suffisant-1';

function healthFacilityCreatedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
  return {
    id: `hfc-session-${tenantId}`,
    eventType: 'tenant.health-facility.created',
    eventVersion: 1,
    aggregateId: tenantId,
    tenantId,
    occurredAt: new Date(),
    payload: { name: 'Etablissement Session HTTP', ownerUserId },
  };
}

function subscriptionStartedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
  return {
    id: `ss-session-${tenantId}`,
    eventType: 'subscription.subscription.started',
    eventVersion: 1,
    aggregateId: `subscription-${tenantId}`,
    tenantId,
    occurredAt: new Date(),
    payload: { planId: `plan-${tenantId}`, trialEndsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ownerUserId },
  };
}

/**
 * `POST /api/v1/auth/sessions` (ADR-0010 §6) — HTTP bout en bout. Fixtures construites via les
 * VRAIS handlers/outboxHandlers de `root` (jamais un double en memoire, jamais de mock sur la
 * persistance) — meme discipline que `provisioningSaga.test.ts`. Chaque scenario logiquement
 * independant utilise sa propre adresse IP source (voir `registrationHttp.test.ts`).
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('POST /api/v1/auth/sessions (ADR-0010 §6)', () => {
  let root: CompositionRoot;
  let handle: TestServerHandle;

  beforeAll(async () => {
    root = buildCompositionRoot();
    handle = await startTestServer(createApp(root));
    await seedPermissionCatalog(root.prisma);
    await seedSystemRoles(root.identity.repositories.roles);
    await seedPlanCatalog(root.subscription.repositories.plans, root.subscription.repositories.planPrices, new SystemClock(), new UuidGenerator());
  });

  afterAll(async () => {
    await handle.close();
    await root.shutdown();
  });

  /** Cree un compte + un etablissement ACCESSIBLE (HealthFacility ACTIVE + Subscription TRIALING), proprietaire ADMIN_ETABLISSEMENT (donc soumis au MFA, §7). */
  async function provisionAccessibleTenant(prefix: string): Promise<{ tenantId: string; ownerUserId: string; ownerEmail: string }> {
    const ownerEmail = uniqueEmail(prefix);
    const accountResult = await root.identity.handlers.createUserAccount.execute({
      email: ownerEmail,
      plainPassword: OWNER_PASSWORD,
      platformRole: 'NONE',
    });
    if (accountResult.isFailure()) {
      throw new Error(`Echec creation compte: ${accountResult.getError()}`);
    }
    const ownerUserId = accountResult.getValue().userAccountId;

    const facilityResult = await root.tenant.handlers.createHealthFacility.execute({
      name: uniqueFacilityName(prefix),
      ownerUserId,
    });
    if (facilityResult.isFailure()) {
      throw new Error(`Echec creation etablissement: ${facilityResult.getError()}`);
    }
    const tenantId = facilityResult.getValue().tenantId;

    await root.subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(healthFacilityCreatedEnvelope(tenantId, ownerUserId));
    await root.identity.outboxHandlers.grantOwnerMembershipOnSubscriptionStarted(subscriptionStartedEnvelope(tenantId, ownerUserId));

    return { tenantId, ownerUserId, ownerEmail };
  }

  /** Cree un membre NON-ADMIN (role ACCUEIL, aucune permission des categories MFA — voir MfaPolicy.ts) sur un tenant deja ACCESSIBLE. */
  async function addNonMfaMember(tenantId: string, ownerUserId: string, prefix: string): Promise<{ userId: string; email: string }> {
    const email = uniqueEmail(prefix);
    const accountResult = await root.identity.handlers.createUserAccount.execute({
      email,
      plainPassword: OWNER_PASSWORD,
      platformRole: 'NONE',
    });
    if (accountResult.isFailure()) {
      throw new Error(`Echec creation compte membre: ${accountResult.getError()}`);
    }
    const userId = accountResult.getValue().userAccountId;

    const grantResult = await root.identity.handlers.grantMembership.execute({
      userId,
      tenantId,
      createdBy: ownerUserId,
      initialRoleCodes: ['ACCUEIL'],
    });
    if (grantResult.isFailure()) {
      throw new Error(`Echec octroi membership: ${grantResult.getError()}`);
    }
    return { userId, email };
  }

  it('email inconnu -> 401 invalid_credentials', async () => {
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: uniqueEmail('session-unknown'), password: 'peu-importe-1' },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_credentials' });
  });

  it('mot de passe faux sur compte existant -> 401 invalid_credentials, reponse STRICTEMENT IDENTIQUE au cas email inconnu (anti-enumeration)', async () => {
    const { ownerEmail } = await provisionAccessibleTenant('session-wrong-password');
    const responseUnknown = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: uniqueEmail('session-unknown-compare'), password: 'peu-importe-1' },
      { localAddress: nextLoopbackIp() },
    );
    const responseWrongPassword = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: ownerEmail, password: 'mauvais-mot-de-passe-1' },
      { localAddress: nextLoopbackIp() },
    );
    expect(responseWrongPassword.status).toBe(401);
    expect(responseUnknown.status).toBe(401);
    expect(responseWrongPassword.body).toBe(responseUnknown.body);
    expect(JSON.parse(responseWrongPassword.body)).toEqual({ error: 'invalid_credentials' });
  });

  it("proprietaire fraichement provisionne (ADMIN_ETABLISSEMENT), sans context, un seul tenant actif -> 200 mfa_required/ENROLLMENT_REQUIRED", async () => {
    const { ownerEmail } = await provisionAccessibleTenant('session-owner-mfa');
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: ownerEmail, password: OWNER_PASSWORD },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { status: string; mfa?: { pendingSessionId: string; reason: string; expiresAt: string } };
    expect(body.status).toBe('mfa_required');
    expect(body.mfa?.reason).toBe('ENROLLMENT_REQUIRED');
    expect(body.mfa?.pendingSessionId).toBeTruthy();
    expect(body.mfa?.expiresAt).toBeTruthy();
  });

  it('utilisateur SANS MFA requis (role ACCUEIL, non administrateur) -> 200 authenticated, sessionId reellement utilisable sur GET /api/v1/audit-entries (403 forbidden car audit:read absent, jamais 401), refreshToken non vide', async () => {
    const { tenantId, ownerUserId } = await provisionAccessibleTenant('session-non-admin-owner');
    const { email } = await addNonMfaMember(tenantId, ownerUserId, 'session-non-admin-member');

    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email, password: OWNER_PASSWORD },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      status: string;
      session: { sessionId: string; kind: string; tenantId: string; roleCodes: string[]; permissionCodes: string[]; absoluteExpiresAt: string };
      refreshToken: string | null;
    };
    expect(body.status).toBe('authenticated');
    expect(body.session.kind).toBe('TENANT');
    expect(body.session.tenantId).toBe(tenantId);
    expect(body.session.roleCodes).toContain('ACCUEIL');
    expect(body.refreshToken).toBeTruthy();
    // Champs JAMAIS exposes (ADR-0010 §6) :
    expect(body.session).not.toHaveProperty('membershipId');
    expect(body.session).not.toHaveProperty('userId');
    expect(body.session).not.toHaveProperty('requiresMfa');
    expect(body.session).not.toHaveProperty('mfaSatisfiedAt');
    expect(body.session).not.toHaveProperty('sensitivityCategory');
    expect(body.session).not.toHaveProperty('issuedAt');

    const auditResponse = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { localAddress: nextLoopbackIp(), headers: bearer(body.session.sessionId) });
    expect(auditResponse.status).toBe(403);
    expect(JSON.parse(auditResponse.body)).toEqual({ error: 'forbidden' });
  });

  it('context.tenantId d_un tenant ou l_utilisateur n_a AUCUN membership -> 403 forbidden, aucune session creee', async () => {
    const { ownerEmail } = await provisionAccessibleTenant('session-foreign-tenant-user');
    const { tenantId: foreignTenantId } = await provisionAccessibleTenant('session-foreign-tenant-target');

    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: ownerEmail, password: OWNER_PASSWORD, context: { kind: 'TENANT', tenantId: foreignTenantId } },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
    expect(response.body).not.toContain(foreignTenantId);
  });

  it('tenant partiellement provisionne (Subscription absente) -> 403 forbidden, reponse INDISTINGUABLE (octet pour octet) d_un tenant inexistant', async () => {
    const ownerEmail = uniqueEmail('session-partial-tenant');
    const accountResult = await root.identity.handlers.createUserAccount.execute({ email: ownerEmail, plainPassword: OWNER_PASSWORD, platformRole: 'NONE' });
    if (accountResult.isFailure()) throw new Error('setup');
    const ownerUserId = accountResult.getValue().userAccountId;
    const facilityResult = await root.tenant.handlers.createHealthFacility.execute({ name: uniqueFacilityName('session-partial-tenant'), ownerUserId });
    if (facilityResult.isFailure()) throw new Error('setup');
    const partialTenantId = facilityResult.getValue().tenantId;
    // AUCUN outboxHandler joue : Subscription n'existe pas -> NOT_FOUND (ADR-0008 §3), jamais un troisieme statut.

    const responsePartial = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: ownerEmail, password: OWNER_PASSWORD, context: { kind: 'TENANT', tenantId: partialTenantId } },
      { localAddress: nextLoopbackIp() },
    );
    const responseNonExistent = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: ownerEmail, password: OWNER_PASSWORD, context: { kind: 'TENANT', tenantId: randomUUID() } },
      { localAddress: nextLoopbackIp() },
    );
    expect(responsePartial.status).toBe(403);
    expect(responseNonExistent.status).toBe(403);
    expect(responsePartial.body).toBe(responseNonExistent.body);
    expect(JSON.parse(responsePartial.body)).toEqual({ error: 'forbidden' });
  });

  it('HealthFacility SUSPENDED -> 403 forbidden, meme reponse que le cas tenant inexistant', async () => {
    const { tenantId, ownerEmail } = await provisionAccessibleTenant('session-suspended');
    const tenantIdVo = TenantId.create(tenantId).getValue();
    const facility = await root.tenant.unitOfWork.withTransaction(() => root.tenant.repositories.healthFacilities.findByTenantId(tenantIdVo), { tenantId: tenantIdVo });
    if (facility === null) throw new Error('setup');
    const suspendResult = facility.suspend();
    if (suspendResult.isFailure()) throw new Error('setup');
    await root.tenant.unitOfWork.withTransaction(() => root.tenant.repositories.healthFacilities.save(facility, tenantIdVo), { tenantId: tenantIdVo });

    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: ownerEmail, password: OWNER_PASSWORD, context: { kind: 'TENANT', tenantId } },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
  });

  it('utilisateur membre de DEUX tenants, sans context -> 200 context_selection_required, aucun sessionId, aucun refreshToken', async () => {
    const { tenantId: tenantA, ownerUserId: ownerA } = await provisionAccessibleTenant('session-multi-tenant-a');
    const { tenantId: tenantB } = await provisionAccessibleTenant('session-multi-tenant-b');
    const { userId: memberId, email: memberEmail } = await addNonMfaMember(tenantA, ownerA, 'session-multi-tenant-member');
    const grantB = await root.identity.handlers.grantMembership.execute({
      userId: memberId,
      tenantId: tenantB,
      createdBy: memberId,
      initialRoleCodes: ['ACCUEIL'],
    });
    if (grantB.isFailure()) throw new Error('setup');

    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: memberEmail, password: OWNER_PASSWORD },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { status: string; availableTenantIds: string[] };
    expect(body.status).toBe('context_selection_required');
    expect(body.availableTenantIds.sort()).toEqual([tenantA, tenantB].sort());
    expect(response.body).not.toContain('sessionId');
    expect(response.body).not.toContain('refreshToken');
  });

  it('corps malforme (champ inconnu) -> 400 invalid_request', async () => {
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: uniqueEmail('session-unknown-field'), password: 'peu-importe-1', unknownField: 'x' },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('context.kind inconnu -> 400 invalid_request', async () => {
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: uniqueEmail('session-bad-context-kind'), password: 'peu-importe-1', context: { kind: 'BOGUS' } },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('context.tenantId non-UUID -> 400 invalid_request', async () => {
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: uniqueEmail('session-bad-tenant-id'), password: 'peu-importe-1', context: { kind: 'TENANT', tenantId: 'pas-un-uuid' } },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('le refreshToken retourne est reellement rotatif : presente a RefreshSessionHandler il produit une nouvelle chaine ; presente deux fois, REUSE_DETECTED (non-regression ADR-0006)', async () => {
    const { tenantId, ownerUserId } = await provisionAccessibleTenant('session-rotation-owner');
    const { email } = await addNonMfaMember(tenantId, ownerUserId, 'session-rotation-member');

    const response = await postJson(handle.baseUrl, '/api/v1/auth/sessions', { email, password: OWNER_PASSWORD }, { localAddress: nextLoopbackIp() });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { refreshToken: string };
    expect(body.refreshToken).toBeTruthy();

    const first = await root.identity.handlers.refreshSession.execute({ refreshToken: body.refreshToken });
    expect(first.isSuccess()).toBe(true);

    const reuse = await root.identity.handlers.refreshSession.execute({ refreshToken: body.refreshToken });
    expect(reuse.isFailure()).toBe(true);
    expect(reuse.getError()).toBe('REUSE_DETECTED');
  });
});
