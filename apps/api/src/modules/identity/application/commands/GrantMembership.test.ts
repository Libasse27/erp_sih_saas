import { beforeEach, describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  idFor,
  InMemoryMembershipAuditTrail,
  InMemoryRoleRepository,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  InMemoryUserTenantMembershipRepository,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { Role } from '../../domain/Role.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { Permission } from '../../domain/value-objects/Permission.js';
import { GrantMembershipHandler } from './GrantMembership.js';

const TENANT_A = TenantId.create(uuidAt(4001)).getValue();

function permission(code: string): Permission {
  return Permission.create(code).getValue();
}

describe('GrantMembershipHandler', () => {
  let accounts: InMemoryUserAccountRepository;
  let memberships: InMemoryUserTenantMembershipRepository;
  let roles: InMemoryRoleRepository;
  let handler: GrantMembershipHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;
  let account: UserAccount;
  let membershipAuditTrail: InMemoryMembershipAuditTrail;

  beforeEach(async () => {
    accounts = new InMemoryUserAccountRepository();
    memberships = new InMemoryUserTenantMembershipRepository();
    roles = new InMemoryRoleRepository();
    clock = new FixedClock('2026-08-23T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    membershipAuditTrail = new InMemoryMembershipAuditTrail();
    handler = new GrantMembershipHandler(
      accounts,
      memberships,
      roles,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
      membershipAuditTrail,
    );

    account = UserAccount.register({
      email: Email.create('infirmier@hopital.sn').getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(account);

    roles.seed(
      Role.system({ id: idFor.role(1), code: 'INFIRMIER', name: 'Infirmier', permissions: [permission('patient:read')] }),
    );
    roles.seed(
      Role.system({
        id: idFor.role(2),
        code: 'RESPONSABLE_RH',
        name: 'RH',
        permissions: [permission('staff-member:write')],
      }),
    );
  });

  it('octroie un membership avec plusieurs roles simultanes — le quota ne compte que le membership, jamais les roles', async () => {
    const result = await handler.execute({
      userId: account.id.toString(),
      tenantId: TENANT_A.toString(),
      createdBy: account.id.toString(),
      initialRoleCodes: ['INFIRMIER', 'RESPONSABLE_RH'],
    });

    expect(result.isSuccess()).toBe(true);
    const active = await memberships.countActive(TENANT_A);
    expect(active).toBe(1);

    const membership = await memberships.findActiveByUserAndTenant(account.id, TENANT_A);
    expect(membership?.roleIds).toHaveLength(2);
  });

  it("refuse un octroi si l'utilisateur n'existe pas", async () => {
    const result = await handler.execute({
      userId: idFor.userAccount(999).toString(),
      tenantId: TENANT_A.toString(),
      createdBy: account.id.toString(),
      initialRoleCodes: [],
    });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('USER_NOT_FOUND');
  });

  it('refuse un octroi si un membership actif existe deja pour ce couple (user, tenant)', async () => {
    await handler.execute({
      userId: account.id.toString(),
      tenantId: TENANT_A.toString(),
      createdBy: account.id.toString(),
      initialRoleCodes: [],
    });
    const result = await handler.execute({
      userId: account.id.toString(),
      tenantId: TENANT_A.toString(),
      createdBy: account.id.toString(),
      initialRoleCodes: [],
    });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('MEMBERSHIP_ALREADY_EXISTS');
  });

  it('refuse un octroi si un code de role est inconnu du catalogue', async () => {
    const result = await handler.execute({
      userId: account.id.toString(),
      tenantId: TENANT_A.toString(),
      createdBy: account.id.toString(),
      initialRoleCodes: ['ROLE_INEXISTANT'],
    });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('ROLE_NOT_FOUND');
  });
});
