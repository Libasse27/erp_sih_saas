import { beforeEach, describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  idFor,
  InMemoryAuditTrail,
  InMemoryMfaEnrollmentRepository,
  InMemorySessionStore,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  InMemoryUserTenantMembershipRepository,
  mustFail,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { MfaEnrollment } from '../../domain/MfaEnrollment.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { EncryptedTotpSecret } from '../../domain/value-objects/EncryptedTotpSecret.js';
import { RecoveryCodeHash } from '../../domain/value-objects/RecoveryCodeHash.js';
import type { PlatformSessionContext, TenantSessionContext } from '../ports/SessionStore.js';
import { ForceMfaReEnrollmentHandler } from './ForceMfaReEnrollment.js';

const TENANT_A = uuidAt(9101);
const TENANT_B = uuidAt(9102);

describe('ForceMfaReEnrollmentHandler', () => {
  let accounts: InMemoryUserAccountRepository;
  let memberships: InMemoryUserTenantMembershipRepository;
  let mfaEnrollments: InMemoryMfaEnrollmentRepository;
  let sessions: InMemorySessionStore;
  let auditTrail: InMemoryAuditTrail;
  let handler: ForceMfaReEnrollmentHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;

  beforeEach(() => {
    accounts = new InMemoryUserAccountRepository();
    memberships = new InMemoryUserTenantMembershipRepository();
    mfaEnrollments = new InMemoryMfaEnrollmentRepository();
    sessions = new InMemorySessionStore();
    auditTrail = new InMemoryAuditTrail();
    clock = new FixedClock('2026-08-26T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    handler = new ForceMfaReEnrollmentHandler(
      sessions,
      accounts,
      memberships,
      mfaEnrollments,
      auditTrail,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
  });

  async function seedMembership(userId: UserAccount['id'], tenantId: string): Promise<void> {
    const tenant = TenantId.create(tenantId).getValue();
    const membership = UserTenantMembership.grant({
      userId,
      tenantId: tenant,
      createdBy: userId,
      initialRoleIds: [],
      clock,
      idGenerator,
    });
    await memberships.save(membership, tenant);
  }

  async function registerAccount(): Promise<UserAccount> {
    const account = UserAccount.register({
      email: Email.create(`u${Date.now()}${Math.random()}@hopital.sn`).getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(account);
    return account;
  }

  function seedActiveEnrollment(userId: UserAccount['id']): void {
    const enrollment = MfaEnrollment.start({
      userId,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });
    enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [RecoveryCodeHash.create('v1.p1.h').getValue()], clock, idGenerator });
    mfaEnrollments.seed(enrollment);
  }

  async function seedTenantActorSession(params: { permissionCodes: string[]; mfaSatisfiedAt: string | null }): Promise<string> {
    const session: TenantSessionContext = {
      sessionId: 'actor-session',
      kind: 'TENANT',
      userId: idFor.userAccount(999).toString(),
      tenantId: TENANT_A,
      membershipId: idFor.membership(1).toString(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: params.permissionCodes,
      requiresMfa: true,
      mfaSatisfiedAt: params.mfaSatisfiedAt,
      issuedAt: clock.now().toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  async function seedPlatformActorSession(mfaSatisfiedAt: string | null): Promise<string> {
    const session: PlatformSessionContext = {
      sessionId: 'platform-actor-session',
      kind: 'PLATFORM',
      userId: idFor.userAccount(998).toString(),
      requiresMfa: true,
      mfaSatisfiedAt,
      issuedAt: clock.now().toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  it('SESSION_NOT_FOUND', async () => {
    const result = await handler.execute({ subjectUserAccountId: idFor.userAccount(1).toString(), actorSessionId: 'inconnue', reason: 'motif' });
    expect(mustFail(result)).toBe('SESSION_NOT_FOUND');
  });

  it('FORBIDDEN : acteur TENANT sans permission mfa:reset (F-4 : audite un refus DENIED)', async () => {
    const actorSessionId = await seedTenantActorSession({ permissionCodes: [], mfaSatisfiedAt: clock.now().toISOString() });
    const result = await handler.execute({ subjectUserAccountId: idFor.userAccount(1).toString(), actorSessionId, reason: 'motif' });
    expect(mustFail(result)).toBe('FORBIDDEN');
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_RE_ENROLLMENT_FORCED', outcome: 'DENIED' });
  });

  it('FORBIDDEN : acteur sans mfaSatisfiedAt (pas de step-up) — F-4 : audite un refus DENIED', async () => {
    const actorSessionId = await seedTenantActorSession({ permissionCodes: ['mfa:reset'], mfaSatisfiedAt: null });
    const result = await handler.execute({ subjectUserAccountId: idFor.userAccount(1).toString(), actorSessionId, reason: 'motif' });
    expect(mustFail(result)).toBe('FORBIDDEN');
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_RE_ENROLLMENT_FORCED', outcome: 'DENIED' });
  });

  it('FORBIDDEN (F-1) : acteur TENANT du tenant A ne peut PAS forcer le ré-enrolement d_un sujet du tenant B (isolation inter-tenant)', async () => {
    const actorSessionId = await seedTenantActorSession({ permissionCodes: ['mfa:reset'], mfaSatisfiedAt: clock.now().toISOString() });
    const subject = await registerAccount();
    seedActiveEnrollment(subject.id);
    await seedMembership(subject.id, TENANT_B);
    const subjectSession: TenantSessionContext = {
      sessionId: 'subject-open-session-tenant-b',
      kind: 'TENANT',
      userId: subject.id.toString(),
      tenantId: TENANT_B,
      membershipId: idFor.membership(3).toString(),
      roleCodes: [],
      permissionCodes: [],
      requiresMfa: false,
      mfaSatisfiedAt: null,
      issuedAt: clock.now().toISOString(),
    };
    await sessions.create(subjectSession);

    const result = await handler.execute({
      subjectUserAccountId: subject.id.toString(),
      actorSessionId,
      reason: 'tentative illegitime cross-tenant',
    });

    expect(mustFail(result)).toBe('FORBIDDEN');
    const enrollment = await mfaEnrollments.findByUserId(subject.id);
    expect(enrollment?.status).toBe('ACTIVE');
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'MFA_RE_ENROLLMENT_FORCED', outcome: 'DENIED' });
    // La session du sujet, ouverte sur le tenant B, doit rester INTACTE (pas de deleteAllForUser sur un refus).
    expect(await sessions.get(subjectSession.sessionId)).not.toBeNull();
  });

  it('FORBIDDEN (F-1) : acteur TENANT du tenant A ne peut PAS forcer le ré-enrolement d_un SUPER_ADMIN (aucun membership dans aucun tenant)', async () => {
    const actorSessionId = await seedTenantActorSession({ permissionCodes: ['mfa:reset'], mfaSatisfiedAt: clock.now().toISOString() });
    const superAdmin = await registerAccount();
    seedActiveEnrollment(superAdmin.id);

    const result = await handler.execute({
      subjectUserAccountId: superAdmin.id.toString(),
      actorSessionId,
      reason: 'tentative illegitime sur un SUPER_ADMIN',
    });

    expect(mustFail(result)).toBe('FORBIDDEN');
    const enrollment = await mfaEnrollments.findByUserId(superAdmin.id);
    expect(enrollment?.status).toBe('ACTIVE');
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'MFA_RE_ENROLLMENT_FORCED', outcome: 'DENIED' });
  });

  it('REASON_REQUIRED : audite quand meme un echec', async () => {
    const actorSessionId = await seedTenantActorSession({ permissionCodes: ['mfa:reset'], mfaSatisfiedAt: clock.now().toISOString() });
    const subject = await registerAccount();
    seedActiveEnrollment(subject.id);

    const result = await handler.execute({ subjectUserAccountId: subject.id.toString(), actorSessionId, reason: '   ' });
    expect(mustFail(result)).toBe('REASON_REQUIRED');
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_RE_ENROLLMENT_FORCED', outcome: 'FAILURE' });
  });

  it('SUBJECT_NOT_FOUND', async () => {
    const actorSessionId = await seedTenantActorSession({ permissionCodes: ['mfa:reset'], mfaSatisfiedAt: clock.now().toISOString() });
    const result = await handler.execute({
      subjectUserAccountId: idFor.userAccount(555).toString(),
      actorSessionId,
      reason: 'motif valide',
    });
    expect(mustFail(result)).toBe('SUBJECT_NOT_FOUND');
  });

  it('ENROLLMENT_NOT_FOUND', async () => {
    const actorSessionId = await seedTenantActorSession({ permissionCodes: ['mfa:reset'], mfaSatisfiedAt: clock.now().toISOString() });
    const subject = await registerAccount();
    await seedMembership(subject.id, TENANT_A);

    const result = await handler.execute({ subjectUserAccountId: subject.id.toString(), actorSessionId, reason: 'motif valide' });
    expect(mustFail(result)).toBe('ENROLLMENT_NOT_FOUND');
  });

  it('succes (acteur TENANT avec mfa:reset) : replace en RESET_REQUIRED, audite le motif, et invalide TOUTES les sessions du sujet', async () => {
    const actorSessionId = await seedTenantActorSession({ permissionCodes: ['mfa:reset'], mfaSatisfiedAt: clock.now().toISOString() });
    const subject = await registerAccount();
    seedActiveEnrollment(subject.id);
    await seedMembership(subject.id, TENANT_A);
    const subjectSession: TenantSessionContext = {
      sessionId: 'subject-open-session',
      kind: 'TENANT',
      userId: subject.id.toString(),
      tenantId: TENANT_A,
      membershipId: idFor.membership(2).toString(),
      roleCodes: [],
      permissionCodes: [],
      requiresMfa: false,
      mfaSatisfiedAt: null,
      issuedAt: clock.now().toISOString(),
    };
    await sessions.create(subjectSession);

    const result = await handler.execute({
      subjectUserAccountId: subject.id.toString(),
      actorSessionId,
      reason: 'perte du telephone, identite verifiee en agence',
    });

    expect(result.isSuccess()).toBe(true);
    const enrollment = await mfaEnrollments.findByUserId(subject.id);
    expect(enrollment?.status).toBe('RESET_REQUIRED');
    expect(auditTrail.records[0]).toMatchObject({
      eventType: 'MFA_RE_ENROLLMENT_FORCED',
      outcome: 'SUCCESS',
      reason: 'perte du telephone, identite verifiee en agence',
    });
    expect(await sessions.get(subjectSession.sessionId)).toBeNull();
  });

  it('succes (acteur PLATFORM, SUPER_ADMIN administrateur inconditionnel)', async () => {
    const actorSessionId = await seedPlatformActorSession(clock.now().toISOString());
    const subject = await registerAccount();
    seedActiveEnrollment(subject.id);

    const result = await handler.execute({ subjectUserAccountId: subject.id.toString(), actorSessionId, reason: 'procedure super admin' });
    expect(result.isSuccess()).toBe(true);
  });
});
