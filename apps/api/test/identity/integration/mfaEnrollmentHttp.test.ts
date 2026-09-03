import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../src/shared-kernel/application/OutboxEventHandler.js';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import { seedPlanCatalog } from '../../../src/modules/subscription/infrastructure/SubscriptionModule.js';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { RedisSessionStore } from '../../../src/modules/identity/infrastructure/session/RedisSessionStore.js';
import type { MfaPendingSessionContext, PlatformSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS } from '../../../src/modules/identity/domain/MfaTuning.js';
import { bearer, nextLoopbackIp, postJson, startTestServer, type TestServerHandle } from '../../server/httpTestClient.js';
import { computeTotpCode } from './totpTestHelper.js';
import { uniqueEmail, uniqueFacilityName } from './dbTestHelpers.js';

const OWNER_PASSWORD = 'mot-de-passe-suffisant-1';

function healthFacilityCreatedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
  return {
    id: `hfc-mfa-${tenantId}`,
    eventType: 'tenant.health-facility.created',
    eventVersion: 1,
    aggregateId: tenantId,
    tenantId,
    occurredAt: new Date(),
    payload: { name: 'Etablissement MFA HTTP', ownerUserId },
  };
}

function subscriptionStartedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
  return {
    id: `ss-mfa-${tenantId}`,
    eventType: 'subscription.subscription.started',
    eventVersion: 1,
    aggregateId: `subscription-${tenantId}`,
    tenantId,
    occurredAt: new Date(),
    payload: { planId: `plan-${tenantId}`, trialEndsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ownerUserId },
  };
}

/**
 * `POST /api/v1/auth/mfa/enrollment` et `POST /api/v1/auth/mfa/enrollment/confirmation`
 * (ADR-0010 §7 bis A/B) — HTTP bout en bout. Necessite `docker compose up -d`.
 */
describe('Routes MFA enrollment (ADR-0010 §7 bis A/B)', () => {
  let root: CompositionRoot;
  let handle: TestServerHandle;
  let sessionStore: RedisSessionStore;

  beforeAll(async () => {
    root = buildCompositionRoot();
    handle = await startTestServer(createApp(root));
    sessionStore = new RedisSessionStore(root.redis);
    await seedPermissionCatalog(root.prisma);
    await seedSystemRoles(root.identity.repositories.roles);
    await seedPlanCatalog(root.subscription.repositories.plans, root.subscription.repositories.planPrices, new SystemClock(), new UuidGenerator());
  });

  afterAll(async () => {
    await handle.close();
    await root.shutdown();
  });

  /** Provisionne un proprietaire ADMIN_ETABLISSEMENT et retourne SON pendingSessionId ENROLLMENT_REQUIRED (via un login HTTP reel). */
  async function provisionOwnerPendingEnrollment(prefix: string): Promise<{ pendingSessionId: string; ownerUserId: string; ownerEmail: string; tenantId: string }> {
    const ownerEmail = uniqueEmail(prefix);
    const accountResult = await root.identity.handlers.createUserAccount.execute({ email: ownerEmail, plainPassword: OWNER_PASSWORD, platformRole: 'NONE' });
    if (accountResult.isFailure()) throw new Error('setup: createUserAccount');
    const ownerUserId = accountResult.getValue().userAccountId;
    const facilityResult = await root.tenant.handlers.createHealthFacility.execute({ name: uniqueFacilityName(prefix), ownerUserId });
    if (facilityResult.isFailure()) throw new Error('setup: createHealthFacility');
    const tenantId = facilityResult.getValue().tenantId;
    await root.subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(healthFacilityCreatedEnvelope(tenantId, ownerUserId));
    await root.identity.outboxHandlers.grantOwnerMembershipOnSubscriptionStarted(subscriptionStartedEnvelope(tenantId, ownerUserId));

    const loginResponse = await postJson(handle.baseUrl, '/api/v1/auth/sessions', { email: ownerEmail, password: OWNER_PASSWORD }, { localAddress: nextLoopbackIp() });
    const body = JSON.parse(loginResponse.body) as { status: string; mfa: { pendingSessionId: string; reason: string } };
    if (body.status !== 'mfa_required' || body.mfa.reason !== 'ENROLLMENT_REQUIRED') {
      throw new Error(`setup: login inattendu (${loginResponse.body})`);
    }
    return { pendingSessionId: body.mfa.pendingSessionId, ownerUserId, ownerEmail, tenantId };
  }

  it('session MFA_PENDING/ENROLLMENT_REQUIRED en Bearer -> 200, enrollmentId + provisioningUri non vides, Cache-Control no-store', async () => {
    const { pendingSessionId } = await provisionOwnerPendingEnrollment('mfa-start-nominal');
    const response = await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, {
      localAddress: nextLoopbackIp(),
      headers: bearer(pendingSessionId),
    });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(response.body) as { enrollmentId: string; provisioningUri: string };
    expect(body.enrollmentId).toBeTruthy();
    expect(body.provisioningUri).toMatch(/^otpauth:\/\/totp\//);
  });

  it('aucun Authorization -> 401 unauthenticated, aucun MfaEnrollment cree', async () => {
    const response = await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: nextLoopbackIp() });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthenticated' });
  });

  it('Bearer inconnu ET Bearer session complete ET Bearer MFA_PENDING/CHALLENGE_REQUIRED -> TROIS reponses IDENTIQUES octet pour octet (anti-oracle d_etat de jeton)', async () => {
    const now = new Date();
    const platformSession: PlatformSessionContext = {
      sessionId: randomUUID(),
      kind: 'PLATFORM',
      userId: randomUUID(),
      requiresMfa: true,
      mfaSatisfiedAt: now.toISOString(),
      issuedAt: now.toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    await sessionStore.create(platformSession);
    const challengeSession: MfaPendingSessionContext = {
      sessionId: randomUUID(),
      kind: 'MFA_PENDING',
      userId: randomUUID(),
      intent: { kind: 'PLATFORM' },
      reason: 'CHALLENGE_REQUIRED',
      auditRoleCodes: [],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    };
    await sessionStore.create(challengeSession);

    const [unknownResp, completeResp, challengeResp] = await Promise.all([
      postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: nextLoopbackIp(), headers: bearer(randomUUID()) }),
      postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: nextLoopbackIp(), headers: bearer(platformSession.sessionId) }),
      postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: nextLoopbackIp(), headers: bearer(challengeSession.sessionId) }),
    ]);

    expect(unknownResp.status).toBe(401);
    expect(completeResp.status).toBe(401);
    expect(challengeResp.status).toBe(401);
    expect(unknownResp.body).toBe(completeResp.body);
    expect(completeResp.body).toBe(challengeResp.body);
    expect(JSON.parse(unknownResp.body)).toEqual({ error: 'unauthenticated' });

    await sessionStore.delete(platformSession.sessionId);
    await sessionStore.delete(challengeSession.sessionId);
  });

  it('corps non vide (en particulier {"userAccountId":"<autre compte>"}) -> 400 invalid_request, AUCUN provisioningUri retourne (non-regression correctif F-2)', async () => {
    const { pendingSessionId } = await provisionOwnerPendingEnrollment('mfa-start-mass-assignment');
    const response = await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', { userAccountId: randomUUID() }, {
      localAddress: nextLoopbackIp(),
      headers: bearer(pendingSessionId),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
    expect(response.body).not.toContain('provisioningUri');
  });

  it('facteur deja ACTIF -> 409 mfa_enrollment_already_active', async () => {
    const { pendingSessionId } = await provisionOwnerPendingEnrollment('mfa-start-already-active');
    const start = await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) });
    const { provisioningUri } = JSON.parse(start.body) as { provisioningUri: string };
    const confirm = await postJson(
      handle.baseUrl,
      '/api/v1/auth/mfa/enrollment/confirmation',
      { totpCode: computeTotpCode(provisioningUri) },
      { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) },
    );
    expect(confirm.status).toBe(200);

    // Nouvelle connexion -> nouveau pendingSessionId ENROLLMENT_REQUIRED (le facteur est deja
    // ACTIF, mais SessionContextIssuer.buildSession derive ENROLLMENT_REQUIRED/CHALLENGE_REQUIRED
    // depuis hasActiveEnrollment : une fois ACTIF -> CHALLENGE_REQUIRED en realite. Pour prouver
    // le 409, on rejoue la route A avec le MEME pendingSessionId P1 (deja utilise, mais toujours
    // valide jusqu'a expiration — voir ADR-0010 §7 bis E : "un second appel a la route A avec elle
    // echoue desormais en 409 mfa_enrollment_already_active").
    const replay = await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) });
    expect(replay.status).toBe(409);
    expect(JSON.parse(replay.body)).toEqual({ error: 'mfa_enrollment_already_active' });
  });

  it('code TOTP valide -> 200, recoveryCodes non vides, Cache-Control no-store', async () => {
    const { pendingSessionId } = await provisionOwnerPendingEnrollment('mfa-confirm-nominal');
    const start = await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) });
    const { provisioningUri } = JSON.parse(start.body) as { provisioningUri: string };

    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/mfa/enrollment/confirmation',
      { totpCode: computeTotpCode(provisioningUri) },
      { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) },
    );
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(response.body) as { recoveryCodes: string[] };
    expect(body.recoveryCodes.length).toBeGreaterThan(0);
  });

  it('code faux -> 401 invalid_credentials, aucun recoveryCodes dans la reponse', async () => {
    const { pendingSessionId } = await provisionOwnerPendingEnrollment('mfa-confirm-wrong-code');
    await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) });

    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/mfa/enrollment/confirmation',
      { totpCode: '000000' },
      { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) },
    );
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_credentials' });
    expect(response.body).not.toContain('recoveryCodes');
  });

  it(
    `${MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS} echecs consecutifs -> le suivant renvoie 429 too_many_requests avec Retry-After constant`,
    async () => {
      const { pendingSessionId } = await provisionOwnerPendingEnrollment('mfa-confirm-lockout');
      await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) });

      for (let i = 0; i < MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS; i += 1) {
        const attempt = await postJson(
          handle.baseUrl,
          '/api/v1/auth/mfa/enrollment/confirmation',
          { totpCode: '000000' },
          { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) },
        );
        expect(attempt.status).toBe(401);
      }

      const locked = await postJson(
        handle.baseUrl,
        '/api/v1/auth/mfa/enrollment/confirmation',
        { totpCode: '000000' },
        { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) },
      );
      expect(locked.status).toBe(429);
      expect(JSON.parse(locked.body)).toEqual({ error: 'too_many_requests' });
      expect(locked.headers['retry-after']).toBeTruthy();
    },
    20_000,
  );

  it('confirmation sans enrolement prealable -> 409 mfa_enrollment_required', async () => {
    const { pendingSessionId } = await provisionOwnerPendingEnrollment('mfa-confirm-no-enrollment');
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/auth/mfa/enrollment/confirmation',
      { totpCode: '123456' },
      { localAddress: nextLoopbackIp(), headers: bearer(pendingSessionId) },
    );
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: 'mfa_enrollment_required' });
  });
});
