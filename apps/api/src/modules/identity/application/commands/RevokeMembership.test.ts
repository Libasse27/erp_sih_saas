import { beforeEach, describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  buildTestRefreshTokenIssuer,
  FixedClock,
  idFor,
  InMemorySessionStore,
  InMemoryUnitOfWork,
  InMemoryUserTenantMembershipRepository,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import { RevokeMembershipHandler } from './RevokeMembership.js';

const TENANT_A = TenantId.create(uuidAt(5001)).getValue();

describe('RevokeMembershipHandler', () => {
  let memberships: InMemoryUserTenantMembershipRepository;
  let sessions: InMemorySessionStore;
  let handler: RevokeMembershipHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;
  let membership: UserTenantMembership;

  beforeEach(async () => {
    memberships = new InMemoryUserTenantMembershipRepository();
    sessions = new InMemorySessionStore();
    clock = new FixedClock('2026-08-23T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    handler = new RevokeMembershipHandler(
      memberships,
      sessions,
      buildTestRefreshTokenIssuer({ clock, idGenerator }),
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );

    membership = UserTenantMembership.grant({
      userId: idFor.userAccount(1),
      tenantId: TENANT_A,
      createdBy: idFor.userAccount(2),
      initialRoleIds: [],
      clock,
      idGenerator,
    });
    await memberships.save(membership, TENANT_A);
  });

  it('revoque le membership : findActiveByUserAndTenant ne le retrouve plus (empeche un nouveau contexte)', async () => {
    const result = await handler.execute({ membershipId: membership.id.toString(), tenantId: TENANT_A.toString() });
    expect(result.isSuccess()).toBe(true);

    const stillActive = await memberships.findActiveByUserAndTenant(idFor.userAccount(1), TENANT_A);
    expect(stillActive).toBeNull();
  });

  it('invalide les sessions deja ouvertes pour ce membership', async () => {
    await sessions.create({
      sessionId: 's1',
      kind: 'TENANT',
      userId: idFor.userAccount(1).toString(),
      tenantId: TENANT_A.toString(),
      membershipId: membership.id.toString(),
      roleCodes: [],
      permissionCodes: [],
      requiresMfa: false,
      mfaSatisfiedAt: null,
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'TENANT_STANDARD',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    });

    await handler.execute({ membershipId: membership.id.toString(), tenantId: TENANT_A.toString() });

    expect(await sessions.get('s1')).toBeNull();
  });

  it('refuse une seconde revocation (deja revoque)', async () => {
    await handler.execute({ membershipId: membership.id.toString(), tenantId: TENANT_A.toString() });
    const result = await handler.execute({ membershipId: membership.id.toString(), tenantId: TENANT_A.toString() });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('MEMBERSHIP_ALREADY_REVOKED');
  });

  it('refuse une revocation sur un membership inexistant', async () => {
    const result = await handler.execute({ membershipId: idFor.membership(999).toString(), tenantId: TENANT_A.toString() });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('MEMBERSHIP_NOT_FOUND');
  });
});
