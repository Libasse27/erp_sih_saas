import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestRefreshTokenIssuer,
  FixedClock,
  idFor,
  InMemoryAuditTrail,
  InMemoryMfaEnrollmentRepository,
  InMemoryRefreshTokenRepository,
  InMemorySessionStore,
  InMemorySuperAdminBreakGlassRequestRepository,
  InMemoryUnitOfWork,
  mustFail,
  SequentialIdGenerator,
} from '../../../../../test/identity/builders/testKit.js';
import { MfaEnrollment } from '../../domain/MfaEnrollment.js';
import { RefreshToken } from '../../domain/RefreshToken.js';
import { SuperAdminBreakGlassRequest } from '../../domain/SuperAdminBreakGlassRequest.js';
import { EncryptedTotpSecret } from '../../domain/value-objects/EncryptedTotpSecret.js';
import { RecoveryCodeHash } from '../../domain/value-objects/RecoveryCodeHash.js';
import { RefreshTokenHash } from '../../domain/value-objects/RefreshTokenHash.js';
import { RefreshTokenId } from '../../domain/value-objects/RefreshTokenId.js';
import { SuperAdminBreakGlassRequestId } from '../../domain/value-objects/SuperAdminBreakGlassRequestId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { PlatformSessionContext, TenantSessionContext } from '../ports/SessionStore.js';
import { ApproveSuperAdminBreakGlassHandler } from './ApproveSuperAdminBreakGlass.js';

const A_SUBJECT = idFor.userAccount(1); // sujet de la recuperation
const B_REQUESTER = idFor.userAccount(2); // demandeur
const C_APPROVER = idFor.userAccount(3); // approbateur legitime (quorum)
const D_OTHER = idFor.userAccount(4); // troisieme SUPER_ADMIN, sans role dans cette demande

describe('ApproveSuperAdminBreakGlassHandler (ADR-0005 Amendement 1, O-04 residu 4 — quorum de deux SUPER_ADMIN)', () => {
  let breakGlassRequests: InMemorySuperAdminBreakGlassRequestRepository;
  let mfaEnrollments: InMemoryMfaEnrollmentRepository;
  let sessions: InMemorySessionStore;
  let auditTrail: InMemoryAuditTrail;
  let refreshTokens: InMemoryRefreshTokenRepository;
  let handler: ApproveSuperAdminBreakGlassHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;

  beforeEach(() => {
    breakGlassRequests = new InMemorySuperAdminBreakGlassRequestRepository();
    mfaEnrollments = new InMemoryMfaEnrollmentRepository();
    sessions = new InMemorySessionStore();
    auditTrail = new InMemoryAuditTrail();
    refreshTokens = new InMemoryRefreshTokenRepository();
    clock = new FixedClock('2026-09-03T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    handler = new ApproveSuperAdminBreakGlassHandler(
      sessions,
      breakGlassRequests,
      mfaEnrollments,
      buildTestRefreshTokenIssuer({ repository: refreshTokens, clock, idGenerator }),
      auditTrail,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
  });

  async function seedPendingRequest(params?: { subjectUserAccountId?: UserAccountId; requestedByUserId?: UserAccountId }): Promise<string> {
    const requestIdResult = SuperAdminBreakGlassRequestId.create(idGenerator.generate());
    const requestId = requestIdResult.getValue();
    const request = SuperAdminBreakGlassRequest.request({
      id: requestId,
      requestedByUserId: params?.requestedByUserId ?? B_REQUESTER,
      subjectUserAccountId: params?.subjectUserAccountId ?? A_SUBJECT,
      reason: 'perte du telephone du SUPER_ADMIN, identite verifiee hors bande',
      clock,
      idGenerator,
    }).getValue();
    await breakGlassRequests.save(request);
    return requestId.toString();
  }

  function seedActiveEnrollment(userId: UserAccountId): void {
    const enrollment = MfaEnrollment.start({
      userId,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });
    enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [RecoveryCodeHash.create('v1.p1.h').getValue()], clock, idGenerator });
    mfaEnrollments.seed(enrollment);
  }

  async function seedPlatformActorSession(params: { sessionId: string; userId: UserAccountId; mfaSatisfiedAt: string | null }): Promise<string> {
    const session: PlatformSessionContext = {
      sessionId: params.sessionId,
      kind: 'PLATFORM',
      userId: params.userId.toString(),
      requiresMfa: true,
      mfaSatisfiedAt: params.mfaSatisfiedAt,
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  async function seedTenantActorSession(userId: UserAccountId): Promise<string> {
    const session: TenantSessionContext = {
      sessionId: 'tenant-actor-session',
      kind: 'TENANT',
      userId: userId.toString(),
      tenantId: idFor.userAccount(9999).toString(),
      membershipId: idFor.membership(1).toString(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['mfa:reset'],
      requiresMfa: true,
      mfaSatisfiedAt: clock.now().toISOString(),
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'TENANT_MFA_REQUIRED',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  /** Ouvre une session (PLATFORM ou TENANT) pour le sujet A — sert a verifier la revocation apres approbation. */
  async function seedSubjectOpenSession(): Promise<string> {
    const session: PlatformSessionContext = {
      sessionId: 'subject-open-session',
      kind: 'PLATFORM',
      userId: A_SUBJECT.toString(),
      requiresMfa: true,
      mfaSatisfiedAt: null,
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  it('SESSION_NOT_FOUND', async () => {
    const requestId = await seedPendingRequest();
    const result = await handler.execute({ requestId, actorSessionId: 'inconnue' });
    expect(mustFail(result)).toBe('SESSION_NOT_FOUND');
  });

  it('REQUEST_NOT_FOUND : requestId inconnu, acteur HABILITE — rien a journaliser (aucun sujet fiable)', async () => {
    const actorSessionId = await seedPlatformActorSession({ sessionId: 'c-session', userId: C_APPROVER, mfaSatisfiedAt: clock.now().toISOString() });
    const unknownRequestId = SuperAdminBreakGlassRequestId.create(idGenerator.generate()).getValue().toString();

    const result = await handler.execute({ requestId: unknownRequestId, actorSessionId });

    expect(mustFail(result)).toBe('REQUEST_NOT_FOUND');
    expect(auditTrail.records).toHaveLength(0);
  });

  it(
    "FORBIDDEN + requestId inconnu (isolation tenant, balayage) : l'autorisation est verifiee AVANT la lecture de la demande — " +
      "un acteur NON habilite reste TOUJOURS audite, meme sur un requestId qui n'existe pas (correctif revue de securite " +
      'independante de l_etape 12/13, MAJEUR-1 : sans cela, un compte compromis pouvait sonder cet endpoint sans laisser aucune trace)',
    async () => {
      const actorSessionId = await seedTenantActorSession(C_APPROVER);
      const unknownRequestId = SuperAdminBreakGlassRequestId.create(idGenerator.generate()).getValue().toString();

      const result = await handler.execute({ requestId: unknownRequestId, actorSessionId });

      expect(mustFail(result)).toBe('FORBIDDEN');
      expect(auditTrail.records).toHaveLength(1);
      expect(auditTrail.records[0]).toMatchObject({
        eventType: 'SUPER_ADMIN_BREAK_GLASS_APPROVED',
        outcome: 'DENIED',
        subjectUserId: C_APPROVER.toString(),
        actorUserId: C_APPROVER.toString(),
      });
    },
  );

  it('FORBIDDEN (approbateur non-MFA refuse) : session PLATFORM sans step-up MFA', async () => {
    const requestId = await seedPendingRequest();
    const actorSessionId = await seedPlatformActorSession({ sessionId: 'c-session', userId: C_APPROVER, mfaSatisfiedAt: null });

    const result = await handler.execute({ requestId, actorSessionId });

    expect(mustFail(result)).toBe('FORBIDDEN');
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'SUPER_ADMIN_BREAK_GLASS_APPROVED', outcome: 'DENIED' });
    const stored = await breakGlassRequests.findById(SuperAdminBreakGlassRequestId.create(requestId).getValue());
    expect(stored?.status).toBe('PENDING');
  });

  it(
    'FORBIDDEN (isolation tenant) : une session TENANT, meme avec des permissions elevees, ne peut JAMAIS approuver — ' +
      "et l'entree d'audit attribue le VRAI tenant/roles de l'acteur (correctif MAJEUR-2, jamais null/[] en dur)",
    async () => {
      const requestId = await seedPendingRequest();
      const actorSessionId = await seedTenantActorSession(C_APPROVER);

      const result = await handler.execute({ requestId, actorSessionId });

      expect(mustFail(result)).toBe('FORBIDDEN');
      const stored = await breakGlassRequests.findById(SuperAdminBreakGlassRequestId.create(requestId).getValue());
      expect(stored?.status).toBe('PENDING');
      expect(auditTrail.records[0]).toMatchObject({
        eventType: 'SUPER_ADMIN_BREAK_GLASS_APPROVED',
        outcome: 'DENIED',
        tenantId: idFor.userAccount(9999).toString(),
        actorRoleCodes: ['ADMIN_ETABLISSEMENT'],
      });
    },
  );

  it('CANNOT_APPROVE_OWN_SUBJECT (auto-approbation interdite) : le sujet A ne peut jamais approuver sa propre demande', async () => {
    const requestId = await seedPendingRequest();
    const actorSessionId = await seedPlatformActorSession({ sessionId: 'a-session', userId: A_SUBJECT, mfaSatisfiedAt: clock.now().toISOString() });

    const result = await handler.execute({ requestId, actorSessionId });

    expect(mustFail(result)).toBe('CANNOT_APPROVE_OWN_SUBJECT');
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'SUPER_ADMIN_BREAK_GLASS_APPROVED', outcome: 'DENIED' });
    const stored = await breakGlassRequests.findById(SuperAdminBreakGlassRequestId.create(requestId).getValue());
    expect(stored?.status).toBe('PENDING');
  });

  it('CANNOT_APPROVE_OWN_REQUEST (sujet = demandeur interdit dans l_autre sens) : le demandeur B ne peut jamais approuver sa propre demande', async () => {
    const requestId = await seedPendingRequest();
    const actorSessionId = await seedPlatformActorSession({ sessionId: 'b-session', userId: B_REQUESTER, mfaSatisfiedAt: clock.now().toISOString() });

    const result = await handler.execute({ requestId, actorSessionId });

    expect(mustFail(result)).toBe('CANNOT_APPROVE_OWN_REQUEST');
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'SUPER_ADMIN_BREAK_GLASS_APPROVED', outcome: 'DENIED' });
    const stored = await breakGlassRequests.findById(SuperAdminBreakGlassRequestId.create(requestId).getValue());
    expect(stored?.status).toBe('PENDING');
  });

  it('ENROLLMENT_NOT_FOUND : le sujet n_a aucun MfaEnrollment (anomalie de donnees, jamais une approbation silencieuse)', async () => {
    const requestId = await seedPendingRequest();
    const actorSessionId = await seedPlatformActorSession({ sessionId: 'c-session', userId: C_APPROVER, mfaSatisfiedAt: clock.now().toISOString() });

    const result = await handler.execute({ requestId, actorSessionId });

    expect(mustFail(result)).toBe('ENROLLMENT_NOT_FOUND');
  });

  it('double approbation : le second appel (meme requete, deja APPROVED) echoue proprement en REQUEST_NOT_PENDING, sans double effet de bord', async () => {
    seedActiveEnrollment(A_SUBJECT);
    const requestId = await seedPendingRequest();
    const firstApproverSession = await seedPlatformActorSession({ sessionId: 'c-session', userId: C_APPROVER, mfaSatisfiedAt: clock.now().toISOString() });

    const first = await handler.execute({ requestId, actorSessionId: firstApproverSession });
    expect(first.isSuccess()).toBe(true);

    const secondApproverSession = await seedPlatformActorSession({ sessionId: 'd-session', userId: D_OTHER, mfaSatisfiedAt: clock.now().toISOString() });
    const second = await handler.execute({ requestId, actorSessionId: secondApproverSession });

    expect(mustFail(second)).toBe('REQUEST_NOT_PENDING');
    // Un seul re-enrolement force applique (pas un second passage en RESET_REQUIRED qui effacerait
    // un ETAT deja renouvele par l'utilisateur entre-temps).
    const enrollment = await mfaEnrollments.findByUserId(A_SUBJECT);
    expect(enrollment?.status).toBe('RESET_REQUIRED');
  });

  it('succes (quorum 2) : C, distinct de A et B, approuve — RESET_REQUIRED, sessions du sujet revoquees, chaine de refresh revoquee, audite SUCCESS', async () => {
    seedActiveEnrollment(A_SUBJECT);
    const requestId = await seedPendingRequest();
    const subjectSessionId = await seedSubjectOpenSession();
    // Chaine de refresh active pour le sujet A, doit etre revoquee par l'approbation.
    await refreshTokens.create(
      RefreshToken.issueNewChain({
        id: RefreshTokenId.create(idGenerator.generate()).getValue(),
        chainId: idGenerator.generate(),
        userId: A_SUBJECT,
        tenantId: null,
        membershipId: null,
        sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
        tokenHash: RefreshTokenHash.create('v1.testpepper.subject-token').getValue(),
        sessionId: subjectSessionId,
        now: clock.now(),
      }),
    );

    const actorSessionId = await seedPlatformActorSession({ sessionId: 'c-session', userId: C_APPROVER, mfaSatisfiedAt: clock.now().toISOString() });

    const result = await handler.execute({ requestId, actorSessionId });

    expect(result.isSuccess()).toBe(true);
    const stored = await breakGlassRequests.findById(SuperAdminBreakGlassRequestId.create(requestId).getValue());
    expect(stored?.status).toBe('APPROVED');
    expect(stored?.approvedByUserId?.toString()).toBe(C_APPROVER.toString());

    const enrollment = await mfaEnrollments.findByUserId(A_SUBJECT);
    expect(enrollment?.status).toBe('RESET_REQUIRED');

    // Revocation des sessions ET de la chaine de refresh du sujet.
    expect(await sessions.get(subjectSessionId)).toBeNull();
    const subjectTokens = refreshTokens.all().filter((t) => t.userId.toString() === A_SUBJECT.toString());
    expect(subjectTokens.length).toBeGreaterThan(0);
    for (const token of subjectTokens) {
      expect(token.status).toBe('REVOKED');
    }

    expect(auditTrail.records.at(-1)).toMatchObject({
      eventType: 'SUPER_ADMIN_BREAK_GLASS_APPROVED',
      outcome: 'SUCCESS',
      subjectUserId: A_SUBJECT.toString(),
      actorUserId: C_APPROVER.toString(),
    });
  });
});
