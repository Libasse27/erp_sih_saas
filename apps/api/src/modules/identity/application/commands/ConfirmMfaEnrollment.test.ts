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
import type { MfaPendingSessionContext, TenantSessionContext } from '../ports/SessionStore.js';
import { ConfirmMfaEnrollmentHandler } from './ConfirmMfaEnrollment.js';

describe('ConfirmMfaEnrollmentHandler', () => {
  let mfaEnrollments: InMemoryMfaEnrollmentRepository;
  let sessions: InMemorySessionStore;
  let totpService: FakeTotpService;
  let recoveryCodeGenerator: FakeRecoveryCodeGenerator;
  let auditTrail: InMemoryAuditTrail;
  let handler: ConfirmMfaEnrollmentHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;

  const USER_ID = idFor.userAccount(1);

  beforeEach(() => {
    mfaEnrollments = new InMemoryMfaEnrollmentRepository();
    sessions = new InMemorySessionStore();
    totpService = new FakeTotpService('123456');
    recoveryCodeGenerator = new FakeRecoveryCodeGenerator();
    auditTrail = new InMemoryAuditTrail();
    clock = new FixedClock('2026-08-26T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    handler = new ConfirmMfaEnrollmentHandler(
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

  function seedPendingEnrollment(): void {
    const enrollment = MfaEnrollment.start({
      userId: USER_ID,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });
    mfaEnrollments.seed(enrollment);
  }

  async function seedPendingEnrollmentSession(userId: string, sessionId = 's1'): Promise<string> {
    const session: MfaPendingSessionContext = {
      sessionId,
      kind: 'MFA_PENDING',
      userId,
      intent: { kind: 'PLATFORM' },
      reason: 'ENROLLMENT_REQUIRED',
      auditRoleCodes: [],
      issuedAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 300_000).toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  it('SESSION_NOT_FOUND', async () => {
    const result = await handler.execute({ totpCode: '123456', sessionId: 'inconnue' });
    expect(mustFail(result)).toBe('SESSION_NOT_FOUND');
  });

  it(
    'SESSION_NOT_PENDING_ENROLLMENT (F-2) : une session TENANT d_un tiers ne peut pas etre utilisee pour confirmer l_enrolement d_un autre compte',
    async () => {
      seedPendingEnrollment();
      const attackerSession: TenantSessionContext = {
        sessionId: 'attacker-session',
        kind: 'TENANT',
        userId: 'attacker-user-id-not-the-victim',
        tenantId: '00000000-0000-4000-8000-000000000001',
        membershipId: '00000000-0000-4000-8000-000000000002',
        roleCodes: [],
        permissionCodes: [],
        requiresMfa: false,
        mfaSatisfiedAt: null,
        issuedAt: clock.now().toISOString(),
      };
      await sessions.create(attackerSession);

      const result = await handler.execute({ totpCode: '123456', sessionId: attackerSession.sessionId });

      expect(mustFail(result)).toBe('SESSION_NOT_PENDING_ENROLLMENT');
      const enrollment = await mfaEnrollments.findByUserId(USER_ID);
      expect(enrollment?.status).toBe('PENDING_ACTIVATION');
      expect(auditTrail.records).toHaveLength(0);
    },
  );

  it('ENROLLMENT_NOT_FOUND : audite quand meme un echec', async () => {
    const sessionId = await seedPendingEnrollmentSession(USER_ID.toString());
    const result = await handler.execute({ totpCode: '123456', sessionId });

    expect(mustFail(result)).toBe('ENROLLMENT_NOT_FOUND');
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_ENROLLMENT_CONFIRMED', outcome: 'FAILURE' });
  });

  it("code invalide : Result.failure ET une entree d'audit FAILURE ET le compteur d'echecs incremente", async () => {
    seedPendingEnrollment();
    const sessionId = await seedPendingEnrollmentSession(USER_ID.toString());

    const result = await handler.execute({ totpCode: 'mauvais-code', sessionId });

    expect(mustFail(result)).toBe('INVALID_CODE');
    const enrollment = await mfaEnrollments.findByUserId(USER_ID);
    expect(enrollment?.consecutiveFailedAttempts).toBe(1);
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_ENROLLMENT_CONFIRMED', outcome: 'FAILURE' });
  });

  it('code valide : active le facteur et renvoie les codes de recuperation en clair une seule fois (premiere activation : MFA_ENROLLMENT_CONFIRMED)', async () => {
    seedPendingEnrollment();
    const sessionId = await seedPendingEnrollmentSession(USER_ID.toString());

    const result = await handler.execute({ totpCode: '123456', sessionId });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().recoveryCodes.length).toBeGreaterThan(0);
    const enrollment = await mfaEnrollments.findByUserId(USER_ID);
    expect(enrollment?.status).toBe('ACTIVE');
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_ENROLLMENT_CONFIRMED', outcome: 'SUCCESS' });
  });

  it('F-5 : un ré-enrolement (apres RESET_REQUIRED, activatedAt deja renseigne) audite MFA_FACTOR_REPLACED, pas MFA_ENROLLMENT_CONFIRMED', async () => {
    const enrollment = MfaEnrollment.start({
      userId: USER_ID,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });
    enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [RecoveryCodeHash.create('v1.p1.old').getValue()], clock, idGenerator });
    enrollment.forceReEnrollment({ requestedByUserId: USER_ID.toString(), reason: 'perte du telephone', clock, idGenerator });
    enrollment.beginReEnrollment({ pendingSecret: EncryptedTotpSecret.create('v1.k2.iv2.tag2.cipher2').getValue(), clock });
    mfaEnrollments.seed(enrollment);
    const sessionId = await seedPendingEnrollmentSession(USER_ID.toString());

    const result = await handler.execute({ totpCode: '123456', sessionId });

    expect(result.isSuccess()).toBe(true);
    const reloaded = await mfaEnrollments.findByUserId(USER_ID);
    expect(reloaded?.status).toBe('ACTIVE');
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_FACTOR_REPLACED', outcome: 'SUCCESS' });
    expect(auditTrail.records.some((r) => r.eventType === 'MFA_ENROLLMENT_CONFIRMED')).toBe(false);
  });

  it('TOO_MANY_ATTEMPTS quand le facteur est deja verrouille, et audite MFA_FACTOR_LOCKED_OUT une seule fois (F-5)', async () => {
    seedPendingEnrollment();
    // Verrouille via 5 echecs successifs.
    for (let i = 0; i < 5; i += 1) {
      const sessionId = await seedPendingEnrollmentSession(USER_ID.toString(), `s-fail-${i}`);
      await handler.execute({ totpCode: 'mauvais-code', sessionId });
    }
    expect(auditTrail.records.filter((r) => r.eventType === 'MFA_FACTOR_LOCKED_OUT')).toHaveLength(1);

    const sessionId = await seedPendingEnrollmentSession(USER_ID.toString(), 's-final');
    const result = await handler.execute({ totpCode: '123456', sessionId });
    expect(mustFail(result)).toBe('TOO_MANY_ATTEMPTS');
    expect(auditTrail.records.filter((r) => r.eventType === 'MFA_FACTOR_LOCKED_OUT')).toHaveLength(1);
  });
});
