import { beforeEach, describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  idFor,
  InMemoryMfaEnrollmentRepository,
  InMemoryRoleRepository,
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
import type { MfaPendingSessionContext, TenantSessionContext } from '../ports/SessionStore.js';
import { SessionContextIssuer } from './SessionContextIssuer.js';

const TENANT_A = TenantId.create(uuidAt(7001)).getValue();

function permission(code: string): Permission {
  return Permission.create(code).getValue();
}

describe('SessionContextIssuer — table de decision ADR-0005 §4', () => {
  let accounts: InMemoryUserAccountRepository;
  let memberships: InMemoryUserTenantMembershipRepository;
  let roles: InMemoryRoleRepository;
  let tenants: InMemoryTenantAccessChecker;
  let mfaEnrollments: InMemoryMfaEnrollmentRepository;
  let issuer: SessionContextIssuer;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;

  beforeEach(() => {
    accounts = new InMemoryUserAccountRepository();
    memberships = new InMemoryUserTenantMembershipRepository();
    roles = new InMemoryRoleRepository();
    tenants = new InMemoryTenantAccessChecker();
    tenants.seed(TENANT_A);
    mfaEnrollments = new InMemoryMfaEnrollmentRepository();
    clock = new FixedClock('2026-08-26T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    issuer = new SessionContextIssuer(
      accounts,
      memberships,
      roles,
      tenants,
      mfaEnrollments,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
  });

  async function accountWithRole(roleCode: string, permissionCode: string): Promise<UserAccount> {
    const account = UserAccount.register({
      email: Email.create(`${roleCode.toLowerCase()}@hopital.sn`).getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(account);
    const role = Role.system({ id: idFor.role(1), code: roleCode, name: roleCode, permissions: [permission(permissionCode)] });
    roles.seed(role);
    await memberships.save(
      UserTenantMembership.grant({ userId: account.id, tenantId: TENANT_A, createdBy: account.id, initialRoleIds: [role.id], clock, idGenerator }),
      TENANT_A,
    );
    return account;
  }

  function activeEnrollmentFor(userId: UserAccount['id']): MfaEnrollment {
    const enrollment = MfaEnrollment.start({
      userId,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });
    enrollment.confirmEnrollment({
      timeStep: 1,
      recoveryCodes: [RecoveryCodeHash.create('v1.p1.hash').getValue()],
      clock,
      idGenerator,
    });
    return enrollment;
  }

  it('requiresMfa=true, enrolement actif => MFA_PENDING / CHALLENGE_REQUIRED', async () => {
    const account = await accountWithRole('ADMIN_ETABLISSEMENT', 'membership:administer');
    mfaEnrollments.seed(activeEnrollmentFor(account.id));

    const result = await issuer.issueForNewContext({ userId: account.id, intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    expect(result.isSuccess()).toBe(true);
    const session = result.getValue() as MfaPendingSessionContext;
    expect(session.kind).toBe('MFA_PENDING');
    expect(session.reason).toBe('CHALLENGE_REQUIRED');
  });

  it('requiresMfa=true, aucun enrolement => MFA_PENDING / ENROLLMENT_REQUIRED', async () => {
    const account = await accountWithRole('ADMIN_ETABLISSEMENT', 'membership:administer');

    const result = await issuer.issueForNewContext({ userId: account.id, intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    expect(result.isSuccess()).toBe(true);
    const session = result.getValue() as MfaPendingSessionContext;
    expect(session.kind).toBe('MFA_PENDING');
    expect(session.reason).toBe('ENROLLMENT_REQUIRED');
  });

  it('requiresMfa=false, enrolement actif => MFA_PENDING / CHALLENGE_REQUIRED (choix conservateur : renforcer, jamais abaisser)', async () => {
    const account = await accountWithRole('MEDECIN', 'patient:read');
    mfaEnrollments.seed(activeEnrollmentFor(account.id));

    const result = await issuer.issueForNewContext({ userId: account.id, intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    expect(result.isSuccess()).toBe(true);
    const session = result.getValue() as MfaPendingSessionContext;
    expect(session.kind).toBe('MFA_PENDING');
    expect(session.reason).toBe('CHALLENGE_REQUIRED');
  });

  it('requiresMfa=false, aucun enrolement => session complete (comportement inchange)', async () => {
    const account = await accountWithRole('MEDECIN', 'patient:read');

    const result = await issuer.issueForNewContext({ userId: account.id, intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    expect(result.isSuccess()).toBe(true);
    const session = result.getValue() as TenantSessionContext;
    expect(session.kind).toBe('TENANT');
    expect(session.permissionCodes).toEqual(['patient:read']);
    expect(session.mfaSatisfiedAt).toBeNull();
  });

  it('issueAfterChallenge re-resout les roles depuis la base et marque mfaSatisfiedAt', async () => {
    const account = await accountWithRole('ADMIN_ETABLISSEMENT', 'membership:administer');
    mfaEnrollments.seed(activeEnrollmentFor(account.id));

    const result = await issuer.issueAfterChallenge({ userId: account.id, intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    expect(result.isSuccess()).toBe(true);
    const session = result.getValue() as TenantSessionContext;
    expect(session.kind).toBe('TENANT');
    expect(session.permissionCodes).toEqual(['membership:administer']);
    expect(session.mfaSatisfiedAt).not.toBeNull();
  });

  it('issueAfterChallenge renvoie CONTEXT_NO_LONGER_AVAILABLE si le membership a ete revoque pendant la fenetre de challenge', async () => {
    const account = await accountWithRole('ADMIN_ETABLISSEMENT', 'membership:administer');
    mfaEnrollments.seed(activeEnrollmentFor(account.id));
    const membership = await memberships.findActiveByUserAndTenant(account.id, TENANT_A);
    membership?.revoke(clock, idGenerator);
    if (membership !== null) {
      await memberships.save(membership, TENANT_A);
    }

    const result = await issuer.issueAfterChallenge({ userId: account.id, intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('CONTEXT_NO_LONGER_AVAILABLE');
  });
});
