import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeRecoveryCodeGenerator,
  FakeTotpService,
  FixedClock,
  idFor,
  InMemoryAuditTrail,
  InMemoryMfaEnrollmentRepository,
  InMemorySessionStore,
  InMemoryUnitOfWork,
  mustFail,
  SequentialIdGenerator,
} from '../../../../../test/identity/builders/testKit.js';
import { MfaEnrollment } from '../../domain/MfaEnrollment.js';
import { EncryptedTotpSecret } from '../../domain/value-objects/EncryptedTotpSecret.js';
import { RecoveryCodeHash } from '../../domain/value-objects/RecoveryCodeHash.js';
import type { MfaPendingSessionContext, PlatformSessionContext } from '../ports/SessionStore.js';
import { RegenerateMfaRecoveryCodesHandler } from './RegenerateMfaRecoveryCodes.js';

const USER_ID = idFor.userAccount(1);

describe('RegenerateMfaRecoveryCodesHandler', () => {
  let mfaEnrollments: InMemoryMfaEnrollmentRepository;
  let sessions: InMemorySessionStore;
  let totpService: FakeTotpService;
  let recoveryCodeGenerator: FakeRecoveryCodeGenerator;
  let auditTrail: InMemoryAuditTrail;
  let handler: RegenerateMfaRecoveryCodesHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;

  beforeEach(() => {
    mfaEnrollments = new InMemoryMfaEnrollmentRepository();
    sessions = new InMemorySessionStore();
    totpService = new FakeTotpService('123456');
    recoveryCodeGenerator = new FakeRecoveryCodeGenerator();
    auditTrail = new InMemoryAuditTrail();
    clock = new FixedClock('2026-08-26T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    handler = new RegenerateMfaRecoveryCodesHandler(
      sessions,
      mfaEnrollments,
      totpService,
      recoveryCodeGenerator,
      auditTrail,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
  });

  function seedActiveEnrollment(): void {
    const enrollment = MfaEnrollment.start({
      userId: USER_ID,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });
    enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [RecoveryCodeHash.create('v1.p1.old').getValue()], clock, idGenerator });
    mfaEnrollments.seed(enrollment);
  }

  async function seedStepUpSession(userId: string, sessionId = 's1'): Promise<string> {
    const session: PlatformSessionContext = {
      sessionId,
      kind: 'PLATFORM',
      userId,
      requiresMfa: true,
      mfaSatisfiedAt: clock.now().toISOString(),
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  it('SESSION_NOT_FOUND', async () => {
    const result = await handler.execute({ sessionId: 'inconnue', totpCode: '123456' });
    expect(mustFail(result)).toBe('SESSION_NOT_FOUND');
  });

  it('STEP_UP_REQUIRED (F-2) : une session MFA_PENDING ne peut pas etre utilisee (pas de step-up prouve)', async () => {
    seedActiveEnrollment();
    const pending: MfaPendingSessionContext = {
      sessionId: 'pending-1',
      kind: 'MFA_PENDING',
      userId: USER_ID.toString(),
      intent: { kind: 'PLATFORM' },
      reason: 'CHALLENGE_REQUIRED',
      auditRoleCodes: [],
      issuedAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 300_000).toISOString(),
    };
    await sessions.create(pending);

    const result = await handler.execute({ sessionId: pending.sessionId, totpCode: '123456' });
    expect(mustFail(result)).toBe('STEP_UP_REQUIRED');
    expect(auditTrail.records).toHaveLength(0);
  });

  it('STEP_UP_REQUIRED (F-2) : une session PLATFORM sans mfaSatisfiedAt ne peut pas etre utilisee', async () => {
    seedActiveEnrollment();
    const notSteppedUp: PlatformSessionContext = {
      sessionId: 'not-stepped-up',
      kind: 'PLATFORM',
      userId: USER_ID.toString(),
      requiresMfa: true,
      mfaSatisfiedAt: null,
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await sessions.create(notSteppedUp);

    const result = await handler.execute({ sessionId: notSteppedUp.sessionId, totpCode: '123456' });
    expect(mustFail(result)).toBe('STEP_UP_REQUIRED');
  });

  it(
    'STEP_UP_REQUIRED (F-2) : le userId provient TOUJOURS de la session, jamais d_un parametre falsifiable — aucun enrolement d_un tiers n_est touche',
    async () => {
      seedActiveEnrollment();
      const otherUserSession: PlatformSessionContext = {
        sessionId: 'other-user-no-stepup',
        kind: 'PLATFORM',
        userId: idFor.userAccount(2).toString(),
        requiresMfa: true,
        mfaSatisfiedAt: null,
        issuedAt: clock.now().toISOString(),
        sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
        absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
      };
      await sessions.create(otherUserSession);

      const result = await handler.execute({ sessionId: otherUserSession.sessionId, totpCode: '123456' });
      expect(mustFail(result)).toBe('STEP_UP_REQUIRED');
      const enrollment = await mfaEnrollments.findByUserId(USER_ID);
      expect(enrollment?.recoveryCodes.some((c) => c.matches(RecoveryCodeHash.create('v1.p1.old').getValue()))).toBe(true);
    },
  );

  it('ENROLLMENT_NOT_FOUND', async () => {
    const sessionId = await seedStepUpSession(USER_ID.toString());
    const result = await handler.execute({ sessionId, totpCode: '123456' });
    expect(mustFail(result)).toBe('ENROLLMENT_NOT_FOUND');
  });

  it('ENROLLMENT_NOT_ACTIVE (jamais confirme)', async () => {
    mfaEnrollments.seed(
      MfaEnrollment.start({ userId: USER_ID, pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(), clock, idGenerator }),
    );
    const sessionId = await seedStepUpSession(USER_ID.toString());

    const result = await handler.execute({ sessionId, totpCode: '123456' });
    expect(mustFail(result)).toBe('ENROLLMENT_NOT_ACTIVE');
  });

  it('code invalide : Result.failure + audit FAILURE + compteur incremente', async () => {
    seedActiveEnrollment();
    const sessionId = await seedStepUpSession(USER_ID.toString());

    const result = await handler.execute({ sessionId, totpCode: 'mauvais' });

    expect(mustFail(result)).toBe('INVALID_CODE');
    const enrollment = await mfaEnrollments.findByUserId(USER_ID);
    expect(enrollment?.consecutiveFailedAttempts).toBe(1);
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_RECOVERY_CODES_REGENERATED', outcome: 'FAILURE' });
  });

  it('succes : remplace le jeu de codes ET renvoie les codes en clair', async () => {
    seedActiveEnrollment();
    const sessionId = await seedStepUpSession(USER_ID.toString());

    const result = await handler.execute({ sessionId, totpCode: '123456' });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().recoveryCodes.length).toBeGreaterThan(0);
    const enrollment = await mfaEnrollments.findByUserId(USER_ID);
    expect(enrollment?.recoveryCodes.some((c) => c.matches(RecoveryCodeHash.create('v1.p1.old').getValue()))).toBe(false);
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_RECOVERY_CODES_REGENERATED', outcome: 'SUCCESS' });
  });

  it('TOO_MANY_ATTEMPTS quand deja verrouille, et audite MFA_FACTOR_LOCKED_OUT une seule fois (F-5)', async () => {
    seedActiveEnrollment();
    for (let i = 0; i < 5; i += 1) {
      const sessionId = await seedStepUpSession(USER_ID.toString(), `s-fail-${i}`);
      await handler.execute({ sessionId, totpCode: 'mauvais' });
    }
    expect(auditTrail.records.filter((r) => r.eventType === 'MFA_FACTOR_LOCKED_OUT')).toHaveLength(1);

    const sessionId = await seedStepUpSession(USER_ID.toString(), 's-final');
    const result = await handler.execute({ sessionId, totpCode: '123456' });
    expect(mustFail(result)).toBe('TOO_MANY_ATTEMPTS');
    expect(auditTrail.records.filter((r) => r.eventType === 'MFA_FACTOR_LOCKED_OUT')).toHaveLength(1);
  });
});
