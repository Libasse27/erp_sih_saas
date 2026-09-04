import { beforeEach, describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  buildTestRefreshTokenIssuer,
  FixedClock,
  idFor,
  InMemoryAuditTrail,
  InMemoryMfaEnrollmentRepository,
  InMemoryRoleRepository,
  InMemorySessionStore,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  InMemoryUserTenantMembershipRepository,
  mustFail,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { MfaEnrollment } from '../../domain/MfaEnrollment.js';
import { Role } from '../../domain/Role.js';
import { SYSTEM_ROLE_CATALOG } from '../../domain/SystemRoleCatalog.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import { Permission } from '../../domain/value-objects/Permission.js';
import { RoleId } from '../../domain/value-objects/RoleId.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { EncryptedTotpSecret } from '../../domain/value-objects/EncryptedTotpSecret.js';
import { RecoveryCodeHash } from '../../domain/value-objects/RecoveryCodeHash.js';
import type { PlatformSessionContext, TenantSessionContext } from '../ports/SessionStore.js';
import { ForceMfaReEnrollmentHandler } from './ForceMfaReEnrollment.js';

const TENANT_A = uuidAt(9101);
const TENANT_B = uuidAt(9102);

const ADMIN_ETABLISSEMENT_DEFINITION = SYSTEM_ROLE_CATALOG.find((role) => role.code === 'ADMIN_ETABLISSEMENT');
if (ADMIN_ETABLISSEMENT_DEFINITION === undefined) {
  throw new Error('ADMIN_ETABLISSEMENT absent de SYSTEM_ROLE_CATALOG (bug de test).');
}
const ADMIN_ETABLISSEMENT_ROLE_ID = RoleId.create(ADMIN_ETABLISSEMENT_DEFINITION.id).getValue();

describe('ForceMfaReEnrollmentHandler', () => {
  let accounts: InMemoryUserAccountRepository;
  let memberships: InMemoryUserTenantMembershipRepository;
  let roles: InMemoryRoleRepository;
  let mfaEnrollments: InMemoryMfaEnrollmentRepository;
  let sessions: InMemorySessionStore;
  let auditTrail: InMemoryAuditTrail;
  let handler: ForceMfaReEnrollmentHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;

  beforeEach(() => {
    accounts = new InMemoryUserAccountRepository();
    memberships = new InMemoryUserTenantMembershipRepository();
    roles = new InMemoryRoleRepository();
    roles.seed(
      Role.system({
        id: ADMIN_ETABLISSEMENT_ROLE_ID,
        code: ADMIN_ETABLISSEMENT_DEFINITION.code,
        name: ADMIN_ETABLISSEMENT_DEFINITION.name,
        permissions: ADMIN_ETABLISSEMENT_DEFINITION.permissionCodes.map((code) => Permission.create(code).getValue()),
      }),
    );
    mfaEnrollments = new InMemoryMfaEnrollmentRepository();
    sessions = new InMemorySessionStore();
    auditTrail = new InMemoryAuditTrail();
    clock = new FixedClock('2026-08-26T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    handler = new ForceMfaReEnrollmentHandler(
      sessions,
      accounts,
      memberships,
      roles,
      mfaEnrollments,
      buildTestRefreshTokenIssuer({ clock, idGenerator }),
      auditTrail,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
  });

  async function seedMembership(userId: UserAccount['id'], tenantId: string, roleIds: readonly RoleId[] = []): Promise<void> {
    const tenant = TenantId.create(tenantId).getValue();
    const membership = UserTenantMembership.grant({
      userId,
      tenantId: tenant,
      createdBy: userId,
      initialRoleIds: [...roleIds],
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
      sensitivityCategory: 'TENANT_MFA_REQUIRED',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
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
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
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
      sensitivityCategory: 'TENANT_STANDARD',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
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
      sensitivityCategory: 'TENANT_STANDARD',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
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

  describe('ADR-0005 Amendement 1 (2026-09-03, O-04 residu 3) — admin-sur-admin', () => {
    it('FORBIDDEN : un acteur TENANT avec mfa:reset ne peut PAS reinitialiser le MFA d_un AUTRE ADMIN_ETABLISSEMENT du meme tenant', async () => {
      const actorSessionId = await seedTenantActorSession({ permissionCodes: ['mfa:reset'], mfaSatisfiedAt: clock.now().toISOString() });
      const subject = await registerAccount();
      seedActiveEnrollment(subject.id);
      await seedMembership(subject.id, TENANT_A, [ADMIN_ETABLISSEMENT_ROLE_ID]);

      const result = await handler.execute({
        subjectUserAccountId: subject.id.toString(),
        actorSessionId,
        reason: 'tentative admin-sur-admin',
      });

      expect(mustFail(result)).toBe('FORBIDDEN');
      expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_RE_ENROLLMENT_FORCED', outcome: 'DENIED' });
      const enrollment = await mfaEnrollments.findByUserId(subject.id);
      expect(enrollment?.status).toBe('ACTIVE');
    });

    it('succes : un acteur TENANT avec mfa:reset garde la capacite de reinitialiser le MFA d_un membre NON-admin de son tenant (capacite preexistante, non retiree)', async () => {
      const actorSessionId = await seedTenantActorSession({ permissionCodes: ['mfa:reset'], mfaSatisfiedAt: clock.now().toISOString() });
      const subject = await registerAccount();
      seedActiveEnrollment(subject.id);
      await seedMembership(subject.id, TENANT_A); // aucun role ADMIN_ETABLISSEMENT

      const result = await handler.execute({
        subjectUserAccountId: subject.id.toString(),
        actorSessionId,
        reason: 'perte du telephone, personnel non-admin',
      });

      expect(result.isSuccess()).toBe(true);
    });

    it('succes : une session PLATFORM (SUPER_ADMIN) peut reinitialiser le MFA d_un ADMIN_ETABLISSEMENT — seule autorite conservee pour ce cas', async () => {
      const actorSessionId = await seedPlatformActorSession(clock.now().toISOString());
      const subject = await registerAccount();
      seedActiveEnrollment(subject.id);
      await seedMembership(subject.id, TENANT_A, [ADMIN_ETABLISSEMENT_ROLE_ID]);

      const result = await handler.execute({ subjectUserAccountId: subject.id.toString(), actorSessionId, reason: 'break-glass/recuperation administree' });

      expect(result.isSuccess()).toBe(true);
    });
  });
});
