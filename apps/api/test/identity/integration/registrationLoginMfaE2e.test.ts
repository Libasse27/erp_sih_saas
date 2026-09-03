import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../src/shared-kernel/application/OutboxEventHandler.js';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import { seedPlanCatalog } from '../../../src/modules/subscription/infrastructure/SubscriptionModule.js';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { bearer, getRequest, nextLoopbackIp, postJson, startTestServer, type TestServerHandle } from '../../server/httpTestClient.js';
import { computeTotpCode } from './totpTestHelper.js';
import { uniqueEmail, uniqueFacilityName } from './dbTestHelpers.js';

function healthFacilityCreatedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
  return {
    id: `hfc-e2e-${tenantId}`,
    eventType: 'tenant.health-facility.created',
    eventVersion: 1,
    aggregateId: tenantId,
    tenantId,
    occurredAt: new Date(),
    payload: { name: 'Etablissement E2E', ownerUserId },
  };
}

function subscriptionStartedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
  return {
    id: `ss-e2e-${tenantId}`,
    eventType: 'subscription.subscription.started',
    eventVersion: 1,
    aggregateId: `subscription-${tenantId}`,
    tenantId,
    occurredAt: new Date(),
    payload: { planId: `plan-${tenantId}`, trialEndsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ownerUserId },
  };
}

function membershipGrantedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
  return {
    id: `mg-e2e-${tenantId}`,
    eventType: 'identity.membership.granted',
    eventVersion: 1,
    aggregateId: `membership-${tenantId}`,
    tenantId,
    occurredAt: new Date(),
    payload: { userId: ownerUserId },
  };
}

function facilityConfigurationSeededEnvelope(tenantId: string): OutboxEventEnvelope {
  return {
    id: `fcs-e2e-${tenantId}`,
    eventType: 'tenant.facility-configuration-seeded',
    eventVersion: 1,
    aggregateId: `settings-${tenantId}`,
    tenantId,
    occurredAt: new Date(),
    payload: { locale: 'fr-SN', timezone: 'Africa/Dakar', currency: 'XOF', phoneCountryCode: '+221' },
  };
}

/**
 * E2E, critere de sortie Phase 0, etape 12/13 (ADR-0010, "Tests attendus" > "Parcours complet") —
 * **integralement HTTP** : chaque fleche du parcours en 8 etapes est une requete HTTP reelle
 * contre l'application Express assemblee par `composition-root.ts`. Aucune etape n'est pilotee
 * au niveau handler, SAUF le relais Outbox lui-meme (etape 2 du parcours) — invoque
 * DIRECTEMENT via les `outboxHandlers` REELS de `root` (meme pattern eprouve par
 * `provisioningSaga.test.ts`), pour ne pas dependre du minuteur de 5s du relais periodique
 * (non demarre ici, `startBackgroundJobs()` n'est jamais appele) : c'est la Saga elle-meme, pas
 * son transport asynchrone, qui est hors mandat de cette ADR (§11).
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('Parcours E2E integralement HTTP — inscription -> provisioning -> connexion -> MFA -> acces tenant (ADR-0010)', () => {
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

  async function runFullSaga(tenantId: string, ownerUserId: string): Promise<void> {
    await root.subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(healthFacilityCreatedEnvelope(tenantId, ownerUserId));
    await root.identity.outboxHandlers.grantOwnerMembershipOnSubscriptionStarted(subscriptionStartedEnvelope(tenantId, ownerUserId));
    await root.tenant.outboxHandlers.seedFacilityConfigurationOnMembershipGranted(membershipGrantedEnvelope(tenantId, ownerUserId));
    await root.tenant.outboxHandlers.completeProvisioningOnFacilityConfigurationSeeded(facilityConfigurationSeededEnvelope(tenantId));
  }

  /** Parcours complet pour UN utilisateur, jusqu'a l'obtention d'un sessionId complet + refreshToken. Retourne tout ce qu'un second parcours (isolation croisee) doit comparer. */
  async function runE2eParcours(prefix: string): Promise<{
    tenantId: string;
    userAccountId: string;
    email: string;
    password: string;
    sessionId: string;
    refreshToken: string;
    allSecrets: readonly string[];
  }> {
    const email = uniqueEmail(prefix);
    const password = 'mot-de-passe-suffisant-1';
    const facilityName = uniqueFacilityName(prefix);
    const ip = nextLoopbackIp();

    // 1. POST /api/v1/registrations -> 202, userAccountId + tenantId.
    const registration = await postJson(handle.baseUrl, '/api/v1/registrations', { email, password, facilityName }, { localAddress: ip });
    expect(registration.status).toBe(202);
    const regBody = JSON.parse(registration.body) as { userAccountId: string; tenantId: string; status: string };
    expect(regBody.status).toBe('provisioning');

    // 2. Relais Outbox (invoque directement, voir commentaire de tete) -> Subscription TRIALING +
    // membership ADMIN_ETABLISSEMENT + FacilitySettings semee + ProvisioningCompleted.
    await runFullSaga(regBody.tenantId, regBody.userAccountId);

    // 3. POST /api/v1/auth/sessions -> 200 mfa_required/ENROLLMENT_REQUIRED, pendingSessionId P1.
    const login1 = await postJson(handle.baseUrl, '/api/v1/auth/sessions', { email, password }, { localAddress: ip });
    expect(login1.status).toBe(200);
    const login1Body = JSON.parse(login1.body) as { status: string; mfa: { pendingSessionId: string; reason: string } };
    expect(login1Body.status).toBe('mfa_required');
    expect(login1Body.mfa.reason).toBe('ENROLLMENT_REQUIRED');
    const p1 = login1Body.mfa.pendingSessionId;

    // Controle de non-contournement intercale : GET /api/v1/audit-entries avec Bearer P1 -> 403
    // mfa_required (non-regression mfaSessionGate.test.ts PAR LA VOIE HTTP).
    const auditWithP1 = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { localAddress: ip, headers: bearer(p1) });
    expect(auditWithP1.status).toBe(403);
    expect(JSON.parse(auditWithP1.body)).toEqual({ error: 'mfa_required' });

    // 4. POST /api/v1/auth/mfa/enrollment avec Bearer P1 -> 200, provisioningUri.
    const start = await postJson(handle.baseUrl, '/api/v1/auth/mfa/enrollment', undefined, { localAddress: ip, headers: bearer(p1) });
    expect(start.status).toBe(200);
    const { provisioningUri } = JSON.parse(start.body) as { provisioningUri: string };

    // 5. POST /api/v1/auth/mfa/enrollment/confirmation avec Bearer P1 et un code TOTP CALCULE
    // DANS LE TEST depuis le secret du provisioningUri -> 200, recoveryCodes.
    const confirm = await postJson(
      handle.baseUrl,
      '/api/v1/auth/mfa/enrollment/confirmation',
      { totpCode: computeTotpCode(provisioningUri) },
      { localAddress: ip, headers: bearer(p1) },
    );
    expect(confirm.status).toBe(200);
    const { recoveryCodes } = JSON.parse(confirm.body) as { recoveryCodes: string[] };
    expect(recoveryCodes.length).toBeGreaterThan(0);

    // Controle de non-contournement intercale : POST /auth/sessions/mfa-challenge avec Bearer P1
    // -> 409 mfa_enrollment_required, JAMAIS une session complete.
    const challengeWithP1 = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions/mfa-challenge',
      { factor: { kind: 'TOTP', code: computeTotpCode(provisioningUri) } },
      { localAddress: ip, headers: bearer(p1) },
    );
    expect(challengeWithP1.status).toBe(409);
    expect(JSON.parse(challengeWithP1.body)).toEqual({ error: 'mfa_enrollment_required' });

    // 6. POST /api/v1/auth/sessions (re-soumission des identifiants, §7 bis E) -> 200
    // mfa_required/CHALLENGE_REQUIRED, pendingSessionId P2 DIFFERENT de P1.
    const login2 = await postJson(handle.baseUrl, '/api/v1/auth/sessions', { email, password }, { localAddress: ip });
    expect(login2.status).toBe(200);
    const login2Body = JSON.parse(login2.body) as { status: string; mfa: { pendingSessionId: string; reason: string } };
    expect(login2Body.status).toBe('mfa_required');
    expect(login2Body.mfa.reason).toBe('CHALLENGE_REQUIRED');
    const p2 = login2Body.mfa.pendingSessionId;
    expect(p2).not.toBe(p1);

    // 7. POST /api/v1/auth/sessions/mfa-challenge avec Bearer P2 et un code TOTP FRAIS -> 200
    // authenticated, sessionId S + refreshToken.
    const challenge = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions/mfa-challenge',
      { factor: { kind: 'TOTP', code: computeTotpCode(provisioningUri) } },
      { localAddress: ip, headers: bearer(p2) },
    );
    expect(challenge.status).toBe(200);
    const challengeBody = JSON.parse(challenge.body) as { status: string; session: { sessionId: string }; refreshToken: string };
    expect(challengeBody.status).toBe('authenticated');
    const sessionId = challengeBody.session.sessionId;
    const refreshToken = challengeBody.refreshToken;
    expect(refreshToken).toBeTruthy();

    // 8. GET /api/v1/audit-entries avec Authorization: Bearer S -> 200, uniquement des entrees du
    // tenant de l'etape 1.
    const auditFinal = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { localAddress: ip, headers: bearer(sessionId) });
    expect(auditFinal.status).toBe(200);
    const auditFinalBody = JSON.parse(auditFinal.body) as { entries: Array<{ tenantId: string | null }> };
    expect(auditFinalBody.entries.length).toBeGreaterThan(0);
    expect(auditFinalBody.entries.every((entry) => entry.tenantId === regBody.tenantId)).toBe(true);

    return {
      tenantId: regBody.tenantId,
      userAccountId: regBody.userAccountId,
      email,
      password,
      sessionId,
      refreshToken,
      allSecrets: [password, provisioningUri, ...recoveryCodes, refreshToken, p1, p2, sessionId],
    };
  }

  it('parcours complet en 8 etapes, integralement HTTP, avec les deux controles de non-contournement intercales', async () => {
    const result = await runE2eParcours('e2e-full');
    expect(result.sessionId).toBeTruthy();
  }, 30_000);

  it('le refreshToken de l_etape 7 est reellement rotatif : presente a RefreshSessionHandler il produit une nouvelle chaine ; presente deux fois, REUSE_DETECTED (non-regression ADR-0006)', async () => {
    const result = await runE2eParcours('e2e-rotation');

    const first = await root.identity.handlers.refreshSession.execute({ refreshToken: result.refreshToken });
    expect(first.isSuccess()).toBe(true);

    const reuse = await root.identity.handlers.refreshSession.execute({ refreshToken: result.refreshToken });
    expect(reuse.isFailure()).toBe(true);
    expect(reuse.getError()).toBe('REUSE_DETECTED');
  }, 30_000);

  it("deux inscriptions distinctes A et B menees jusqu'a l'etape 8 : la session de A n'accede JAMAIS a une donnee de B", async () => {
    const a = await runE2eParcours('e2e-cross-a');
    const b = await runE2eParcours('e2e-cross-b');

    const auditAsA = await getRequest(handle.baseUrl, '/api/v1/audit-entries?limit=200', { localAddress: nextLoopbackIp(), headers: bearer(a.sessionId) });
    expect(auditAsA.status).toBe(200);
    expect(auditAsA.body).not.toContain(b.tenantId);
    expect(auditAsA.body).not.toContain(b.userAccountId);

    const auditAsB = await getRequest(handle.baseUrl, '/api/v1/audit-entries?limit=200', { localAddress: nextLoopbackIp(), headers: bearer(b.sessionId) });
    expect(auditAsB.status).toBe(200);
    expect(auditAsB.body).not.toContain(a.tenantId);
    expect(auditAsB.body).not.toContain(a.userAccountId);

    // Le sessionId de B n'ouvre jamais le tenant de A (verification directe, meme raisonnement
    // que sessionHttp.test.ts "context.tenantId d'un tenant ou l'utilisateur n'a aucun membership").
    const crossLogin = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: b.email, password: b.password, context: { kind: 'TENANT', tenantId: a.tenantId } },
      { localAddress: nextLoopbackIp() },
    );
    expect(crossLogin.status).toBe(403);
    expect(JSON.parse(crossLogin.body)).toEqual({ error: 'forbidden' });
  }, 60_000);

  it('aucun secret du parcours (mot de passe, provisioningUri, recoveryCodes, refreshToken, pendingSessionId, sessionId) n_apparait dans une AuditEntry', async () => {
    const result = await runE2eParcours('e2e-no-secret-leak');

    const rows = await root.prisma.auditEntry.findMany({
      where: { OR: [{ subjectUserId: result.userAccountId }, { tenantId: result.tenantId }] },
    });
    expect(rows.length).toBeGreaterThan(0);
    // `AuditEntry.chainSequence` (BigInt?, schema.prisma) revient en `bigint` JS natif — non
    // serialisable par `JSON.stringify` sans replacer (bug de test, sans rapport avec la
    // securite : la recherche de secrets ci-dessous porte sur les CHAINES du corps, jamais sur ce
    // champ numerique).
    const serialized = JSON.stringify(rows, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
    for (const secret of result.allSecrets) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain(result.email);
  }, 30_000);
});
