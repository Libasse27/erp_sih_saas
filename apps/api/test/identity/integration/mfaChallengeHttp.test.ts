import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../src/shared-kernel/application/OutboxEventHandler.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import { seedPlanCatalog } from '../../../src/modules/subscription/infrastructure/SubscriptionModule.js';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { bearer, getRequest, nextLoopbackIp, postJson, startTestServer, type TestServerHandle } from '../../server/httpTestClient.js';
import { computeTotpCode } from './totpTestHelper.js';
import { uniqueEmail, uniqueFacilityName } from './dbTestHelpers.js';

const OWNER_PASSWORD = 'mot-de-passe-suffisant-1';

function healthFacilityCreatedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
  return {
    id: `hfc-challenge-${tenantId}`,
    eventType: 'tenant.health-facility.created',
    eventVersion: 1,
    aggregateId: tenantId,
    tenantId,
    occurredAt: new Date(),
    payload: { name: 'Etablissement Challenge HTTP', ownerUserId },
  };
}

function subscriptionStartedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
  return {
    id: `ss-challenge-${tenantId}`,
    eventType: 'subscription.subscription.started',
    eventVersion: 1,
    aggregateId: `subscription-${tenantId}`,
    tenantId,
    occurredAt: new Date(),
    payload: { planId: `plan-${tenantId}`, trialEndsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ownerUserId },
  };
}

/**
 * `POST /api/v1/auth/sessions/mfa-challenge` (ADR-0010 §7 bis C) — HTTP bout en bout. Necessite
 * `docker compose up -d`.
 */
describe('POST /api/v1/auth/sessions/mfa-challenge (ADR-0010 §7 bis C)', () => {
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

  /**
   * Provisionne un proprietaire, l'enrole COMPLETEMENT (TOTP actif) et retourne un
   * `pendingSessionId` `CHALLENGE_REQUIRED` frais (P2), le `provisioningUri` (pour recalculer un
   * code TOTP frais au moment du challenge — TOTP est fonction du temps, le code de la
   * confirmation n'est valable que dans SA fenetre de 30s) et les `recoveryCodes` emis.
   */
  async function provisionOwnerReadyForChallenge(prefix: string): Promise<{
    tenantId: string;
    ownerUserId: string;
    ownerEmail: string;
    pendingSessionId: string;
    provisioningUri: string;
    recoveryCodes: string[];
  }> {
    const ownerEmail = uniqueEmail(prefix);
    const accountResult = await root.identity.handlers.createUserAccount.execute({ email: ownerEmail, plainPassword: OWNER_PASSWORD, platformRole: 'NONE' });
    if (accountResult.isFailure()) throw new Error('setup: createUserAccount');
    const ownerUserId = accountResult.getValue().userAccountId;
    const facilityResult = await root.tenant.handlers.createHealthFacility.execute({ name: uniqueFacilityName(prefix), ownerUserId });
    if (facilityResult.isFailure()) throw new Error('setup: createHealthFacility');
    const tenantId = facilityResult.getValue().tenantId;
    await root.subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(healthFacilityCreatedEnvelope(tenantId, ownerUserId));
    await root.identity.outboxHandlers.grantOwnerMembershipOnSubscriptionStarted(subscriptionStartedEnvelope(tenantId, ownerUserId));

    const login1 = await postJson(handle.baseUrl, '/api/v1/auth/sessions', { email: ownerEmail, password: OWNER_PASSWORD }, { localAddress: nextLoopbackIp() });
    const login1Body = JSON.parse(login1.body) as { mfa: { pendingSessionId: string } };
    const p1 = login1Body.mfa.pendingSessionId;

    const start = await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: nextLoopbackIp(), headers: bearer(p1) });
    const { provisioningUri } = JSON.parse(start.body) as { provisioningUri: string };
    const confirm = await postJson(
      handle.baseUrl,
      '/api/v1/auth/mfa/enrollment/confirmation',
      { totpCode: computeTotpCode(provisioningUri) },
      { localAddress: nextLoopbackIp(), headers: bearer(p1) },
    );
    const { recoveryCodes } = JSON.parse(confirm.body) as { recoveryCodes: string[] };

    const login2 = await postJson(handle.baseUrl, '/api/v1/auth/sessions', { email: ownerEmail, password: OWNER_PASSWORD }, { localAddress: nextLoopbackIp() });
    const login2Body = JSON.parse(login2.body) as { status: string; mfa: { pendingSessionId: string; reason: string } };
    if (login2Body.status !== 'mfa_required' || login2Body.mfa.reason !== 'CHALLENGE_REQUIRED') {
      throw new Error(`setup: re-login inattendu (${login2.body})`);
    }

    return { tenantId, ownerUserId, ownerEmail, pendingSessionId: login2Body.mfa.pendingSessionId, provisioningUri, recoveryCodes };
  }

  it('code TOTP valide -> 200 authenticated, sessionId reellement utilisable en Bearer sur GET /api/v1/audit-entries, refreshToken retourne', async () => {
    const { pendingSessionId, provisioningUri, tenantId } = await provisionOwnerReadyForChallenge('challenge-totp-nominal');

    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions/mfa-challenge',
      { factor: { kind: 'TOTP', code: computeTotpCode(provisioningUri) } },
      { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) },
    );
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(response.body) as { status: string; session: { sessionId: string; tenantId: string }; refreshToken: string | null };
    expect(body.status).toBe('authenticated');
    expect(body.session.tenantId).toBe(tenantId);
    expect(body.refreshToken).toBeTruthy();
    expect(body.session).not.toHaveProperty('membershipId');
    expect(body.session).not.toHaveProperty('userId');
    expect(body.session).not.toHaveProperty('requiresMfa');
    expect(body.session).not.toHaveProperty('mfaSatisfiedAt');
    expect(body.session).not.toHaveProperty('sensitivityCategory');
    expect(body.session).not.toHaveProperty('issuedAt');

    const auditResponse = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { localAddress: nextLoopbackIp(), headers: bearer(body.session.sessionId) });
    // ADMIN_ETABLISSEMENT porte `audit:read` (SystemRoleCatalog.ts) -> 200, jamais 401.
    expect(auditResponse.status).toBe(200);
  });

  it('code de recuperation NON consomme -> 200, code marque consomme ; le MEME code rejoue (nouveau pendingSessionId CHALLENGE_REQUIRED) -> 401 invalid_credentials', async () => {
    const { pendingSessionId, ownerEmail, recoveryCodes } = await provisionOwnerReadyForChallenge('challenge-recovery-code');
    const code = recoveryCodes[0];
    if (code === undefined) throw new Error('setup: recoveryCodes vide');

    const first = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions/mfa-challenge',
      { factor: { kind: 'RECOVERY_CODE', code } },
      { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) },
    );
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body).status).toBe('authenticated');

    // P2 vient d'etre CONSOMME par le succes ci-dessus (session complete emise, ADR-0010 §7 bis
    // E) — une nouvelle connexion produit un P2' CHALLENGE_REQUIRED distinct, sur lequel on
    // REJOUE exactement le meme code de recuperation (deja consomme cote agregat, independamment
    // du pendingSessionId utilise).
    const relogin = await postJson(handle.baseUrl, '/api/v1/auth/sessions', { email: ownerEmail, password: OWNER_PASSWORD }, { localAddress: nextLoopbackIp() });
    const p2bis = (JSON.parse(relogin.body) as { mfa: { pendingSessionId: string } }).mfa.pendingSessionId;

    const replay = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions/mfa-challenge',
      { factor: { kind: 'RECOVERY_CODE', code } },
      { localAddress: nextLoopbackIp(), headers: bearer(p2bis) },
    );
    expect(replay.status).toBe(401);
    expect(JSON.parse(replay.body)).toEqual({ error: 'invalid_credentials' });
  });

  it('code TOTP faux et code de recuperation faux -> reponses IDENTIQUES (401 invalid_credentials), jamais de distinction du facteur en echec', async () => {
    const { pendingSessionId: sessionForTotp } = await provisionOwnerReadyForChallenge('challenge-wrong-totp');
    const { pendingSessionId: sessionForRecovery } = await provisionOwnerReadyForChallenge('challenge-wrong-recovery');

    const wrongTotp = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions/mfa-challenge',
      { factor: { kind: 'TOTP', code: '000000' } },
      { localAddress: nextLoopbackIp(), headers: bearer(sessionForTotp) },
    );
    const wrongRecovery = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions/mfa-challenge',
      { factor: { kind: 'RECOVERY_CODE', code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' } },
      { localAddress: nextLoopbackIp(), headers: bearer(sessionForRecovery) },
    );
    expect(wrongTotp.status).toBe(401);
    expect(wrongRecovery.status).toBe(401);
    expect(wrongTotp.body).toBe(wrongRecovery.body);
    expect(JSON.parse(wrongTotp.body)).toEqual({ error: 'invalid_credentials' });
  });

  it('factor.kind inconnu -> 400 invalid_request, aucune tentative comptabilisee sur l_agregat', async () => {
    const { pendingSessionId } = await provisionOwnerReadyForChallenge('challenge-bad-factor-kind');
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions/mfa-challenge',
      { factor: { kind: 'BOGUS', code: '123456' } },
      { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it("session MFA_PENDING/ENROLLMENT_REQUIRED (celle ayant servi a l_enrolement, reutilisee apres confirmation) -> 409 mfa_enrollment_required, aucune session complete emise", async () => {
    const ownerEmail = uniqueEmail('challenge-p1-reuse');
    const accountResult = await root.identity.handlers.createUserAccount.execute({ email: ownerEmail, plainPassword: OWNER_PASSWORD, platformRole: 'NONE' });
    if (accountResult.isFailure()) throw new Error('setup');
    const ownerUserId = accountResult.getValue().userAccountId;
    const facilityResult = await root.tenant.handlers.createHealthFacility.execute({ name: uniqueFacilityName('challenge-p1-reuse'), ownerUserId });
    if (facilityResult.isFailure()) throw new Error('setup');
    const tenantId = facilityResult.getValue().tenantId;
    await root.subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(healthFacilityCreatedEnvelope(tenantId, ownerUserId));
    await root.identity.outboxHandlers.grantOwnerMembershipOnSubscriptionStarted(subscriptionStartedEnvelope(tenantId, ownerUserId));

    const login1 = await postJson(handle.baseUrl, '/api/v1/auth/sessions', { email: ownerEmail, password: OWNER_PASSWORD }, { localAddress: nextLoopbackIp() });
    const p1 = (JSON.parse(login1.body) as { mfa: { pendingSessionId: string } }).mfa.pendingSessionId;
    const start = await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: nextLoopbackIp(), headers: bearer(p1) });
    const { provisioningUri } = JSON.parse(start.body) as { provisioningUri: string };
    await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment/confirmation', { totpCode: computeTotpCode(provisioningUri) }, { localAddress: nextLoopbackIp(), headers: bearer(p1) });

    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions/mfa-challenge',
      { factor: { kind: 'TOTP', code: computeTotpCode(provisioningUri) } },
      { localAddress: nextLoopbackIp(), headers: bearer(p1) },
    );
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: 'mfa_enrollment_required' });
  });

  it('membership revoque PENDANT la fenetre de challenge -> 403 forbidden, aucune session emise', async () => {
    const { pendingSessionId, provisioningUri, tenantId, ownerUserId } = await provisionOwnerReadyForChallenge('challenge-revoked-membership');

    const tenantIdVo = TenantId.create(tenantId).getValue();
    const ownerIdVo = UserAccountId.create(ownerUserId).getValue();
    const membership = await root.identity.unitOfWork.withTransaction(
      () => root.identity.repositories.memberships.findActiveByUserAndTenant(ownerIdVo, tenantIdVo),
      { tenantId: tenantIdVo },
    );
    if (membership === null) throw new Error('setup: membership introuvable');
    const revokeResult = await root.identity.handlers.revokeMembership.execute({ membershipId: membership.id.toString(), tenantId });
    expect(revokeResult.isSuccess()).toBe(true);

    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions/mfa-challenge',
      { factor: { kind: 'TOTP', code: computeTotpCode(provisioningUri) } },
      { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) },
    );
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' });
  });
});
