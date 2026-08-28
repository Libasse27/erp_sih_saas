import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestRefreshTokenIssuer,
  FakeRecoveryCodeHasher,
  FakeTotpService,
  FixedClock,
  idFor,
  InMemoryAuditTrail,
  InMemoryMfaEnrollmentRepository,
  InMemoryRoleRepository,
  InMemorySessionStore,
  InMemoryTenantAccessChecker,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  InMemoryUserTenantMembershipRepository,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { MfaEnrollment } from '../../domain/MfaEnrollment.js';
import { Role } from '../../domain/Role.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { Permission } from '../../domain/value-objects/Permission.js';
import { EncryptedTotpSecret } from '../../domain/value-objects/EncryptedTotpSecret.js';
import { RecoveryCodeHash } from '../../domain/value-objects/RecoveryCodeHash.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { MfaPendingSessionContext, TenantSessionContext } from '../ports/SessionStore.js';
import { SessionContextIssuer } from '../services/SessionContextIssuer.js';
import { VerifyMfaChallengeHandler } from './VerifyMfaChallenge.js';

const TENANT_A = TenantId.create(uuidAt(8001)).getValue();

describe('VerifyMfaChallengeHandler', () => {
  let accounts: InMemoryUserAccountRepository;
  let memberships: InMemoryUserTenantMembershipRepository;
  let roles: InMemoryRoleRepository;
  let tenants: InMemoryTenantAccessChecker;
  let mfaEnrollments: InMemoryMfaEnrollmentRepository;
  let sessions: InMemorySessionStore;
  let totpService: FakeTotpService;
  let recoveryCodeHasher: FakeRecoveryCodeHasher;
  let auditTrail: InMemoryAuditTrail;
  let handler: VerifyMfaChallengeHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;

  beforeEach(() => {
    accounts = new InMemoryUserAccountRepository();
    memberships = new InMemoryUserTenantMembershipRepository();
    roles = new InMemoryRoleRepository();
    tenants = new InMemoryTenantAccessChecker();
    tenants.seed(TENANT_A);
    mfaEnrollments = new InMemoryMfaEnrollmentRepository();
    sessions = new InMemorySessionStore();
    totpService = new FakeTotpService('123456');
    recoveryCodeHasher = new FakeRecoveryCodeHasher();
    auditTrail = new InMemoryAuditTrail();
    clock = new FixedClock('2026-08-26T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    const issuer = new SessionContextIssuer(
      accounts,
      memberships,
      roles,
      tenants,
      mfaEnrollments,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
    handler = new VerifyMfaChallengeHandler(
      sessions,
      mfaEnrollments,
      totpService,
      recoveryCodeHasher,
      issuer,
      buildTestRefreshTokenIssuer({ clock, idGenerator }),
      auditTrail,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
  });

  async function seedMemberAccount(): Promise<UserAccount> {
    const account = UserAccount.register({
      email: Email.create('member@hopital.sn').getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(account);
    const role = Role.system({ id: idFor.role(1), code: 'ADMIN_ETABLISSEMENT', name: 'Admin', permissions: [Permission.create('membership:administer').getValue()] });
    roles.seed(role);
    await memberships.save(
      UserTenantMembership.grant({ userId: account.id, tenantId: TENANT_A, createdBy: account.id, initialRoleIds: [role.id], clock, idGenerator }),
      TENANT_A,
    );
    return account;
  }

  function seedActiveEnrollment(userId: UserAccount['id'], recoveryCodePlain?: string): void {
    const enrollment = MfaEnrollment.start({
      userId,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });
    const hashes = recoveryCodePlain !== undefined ? [recoveryCodeHasher.hash(recoveryCodePlain)] : [RecoveryCodeHash.create('v1.p1.unused').getValue()];
    enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: hashes, clock, idGenerator });
    mfaEnrollments.seed(enrollment);
  }

  function seedPendingSession(userId: string): MfaPendingSessionContext {
    const session: MfaPendingSessionContext = {
      sessionId: 'pending-1',
      kind: 'MFA_PENDING',
      userId,
      intent: { kind: 'TENANT', tenantId: TENANT_A.toString() },
      reason: 'CHALLENGE_REQUIRED',
      auditRoleCodes: ['ADMIN_ETABLISSEMENT'],
      issuedAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 300_000).toISOString(),
    };
    void sessions.create(session);
    return session;
  }

  it('SESSION_NOT_FOUND', async () => {
    const result = await handler.execute({ pendingSessionId: 'inconnue', factor: { kind: 'TOTP', code: '123456' } });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('SESSION_NOT_FOUND');
  });

  it('ENROLLMENT_REQUIRED quand la session en attente porte ce motif', async () => {
    const account = await seedMemberAccount();
    const session: MfaPendingSessionContext = {
      sessionId: 'pending-2',
      kind: 'MFA_PENDING',
      userId: account.id.toString(),
      intent: { kind: 'TENANT', tenantId: TENANT_A.toString() },
      reason: 'ENROLLMENT_REQUIRED',
      auditRoleCodes: [],
      issuedAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 300_000).toISOString(),
    };
    await sessions.create(session);

    const result = await handler.execute({ pendingSessionId: session.sessionId, factor: { kind: 'TOTP', code: '123456' } });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('ENROLLMENT_REQUIRED');
  });

  it('code TOTP valide : re-emet une session complete avec mfaSatisfiedAt et audite le succes', async () => {
    const account = await seedMemberAccount();
    seedActiveEnrollment(account.id);
    const pending = seedPendingSession(account.id.toString());

    const result = await handler.execute({ pendingSessionId: pending.sessionId, factor: { kind: 'TOTP', code: '123456' } });

    expect(result.isSuccess()).toBe(true);
    const session = result.getValue().session as TenantSessionContext;
    expect(session.kind).toBe('TENANT');
    expect(session.mfaSatisfiedAt).not.toBeNull();
    expect(await sessions.get(pending.sessionId)).toBeNull();
    expect(auditTrail.records.some((r) => r.eventType === 'MFA_CHALLENGE_SUCCEEDED' && r.outcome === 'SUCCESS')).toBe(true);
  });

  it("code TOTP invalide : Result.failure INVALID_CODE, entree d'audit FAILURE, ET compteur d'echecs incremente (persistes ensemble)", async () => {
    const account = await seedMemberAccount();
    seedActiveEnrollment(account.id);
    const pending = seedPendingSession(account.id.toString());

    const result = await handler.execute({ pendingSessionId: pending.sessionId, factor: { kind: 'TOTP', code: 'mauvais' } });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_CODE');
    const enrollment = await mfaEnrollments.findByUserId(account.id);
    expect(enrollment?.consecutiveFailedAttempts).toBe(1);
    expect(auditTrail.records.some((r) => r.eventType === 'MFA_CHALLENGE_FAILED' && r.outcome === 'FAILURE')).toBe(true);
  });

  it('TOO_MANY_ATTEMPTS quand le facteur est deja verrouille (audite DENIED)', async () => {
    const account = await seedMemberAccount();
    seedActiveEnrollment(account.id);
    for (let i = 0; i < 5; i += 1) {
      const pending = seedPendingSession(account.id.toString());
      await handler.execute({ pendingSessionId: pending.sessionId, factor: { kind: 'TOTP', code: 'mauvais' } });
    }

    const pending = seedPendingSession(account.id.toString());
    const result = await handler.execute({ pendingSessionId: pending.sessionId, factor: { kind: 'TOTP', code: '123456' } });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('TOO_MANY_ATTEMPTS');
    expect(auditTrail.records.some((r) => r.eventType === 'MFA_CHALLENGE_BLOCKED' && r.outcome === 'DENIED')).toBe(true);
  });

  it('F-5 : le verrouillage au seuil ecrit une entree MFA_FACTOR_LOCKED_OUT distincte, une seule fois', async () => {
    const account = await seedMemberAccount();
    seedActiveEnrollment(account.id);
    for (let i = 0; i < 4; i += 1) {
      const pending = seedPendingSession(account.id.toString());
      await handler.execute({ pendingSessionId: pending.sessionId, factor: { kind: 'TOTP', code: 'mauvais' } });
    }
    expect(auditTrail.records.filter((r) => r.eventType === 'MFA_FACTOR_LOCKED_OUT')).toHaveLength(0);

    const lockingAttempt = seedPendingSession(account.id.toString());
    const result = await handler.execute({ pendingSessionId: lockingAttempt.sessionId, factor: { kind: 'TOTP', code: 'mauvais' } });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_CODE');
    const lockedOutEntries = auditTrail.records.filter((r) => r.eventType === 'MFA_FACTOR_LOCKED_OUT');
    expect(lockedOutEntries).toHaveLength(1);
    expect(lockedOutEntries[0]).toMatchObject({ outcome: 'FAILURE' });

    // Une tentative ULTERIEURE (deja verrouillee) ne doit PAS reecrire MFA_FACTOR_LOCKED_OUT.
    const blockedAttempt = seedPendingSession(account.id.toString());
    await handler.execute({ pendingSessionId: blockedAttempt.sessionId, factor: { kind: 'TOTP', code: '123456' } });
    expect(auditTrail.records.filter((r) => r.eventType === 'MFA_FACTOR_LOCKED_OUT')).toHaveLength(1);
  });

  it('code de recuperation valide : consomme le code et re-emet une session complete', async () => {
    const account = await seedMemberAccount();
    seedActiveEnrollment(account.id, 'CODE-1');
    const pending = seedPendingSession(account.id.toString());

    const result = await handler.execute({ pendingSessionId: pending.sessionId, factor: { kind: 'RECOVERY_CODE', code: 'CODE-1' } });

    expect(result.isSuccess()).toBe(true);
    expect(auditTrail.records.some((r) => r.eventType === 'MFA_RECOVERY_CODE_CONSUMED' && r.outcome === 'SUCCESS')).toBe(true);
  });
});
