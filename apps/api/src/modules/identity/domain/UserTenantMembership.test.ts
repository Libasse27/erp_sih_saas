import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { FixedClock, idFor, SequentialIdGenerator, uuidAt } from '../../../../test/identity/builders/testKit.js';
import { UserTenantMembership } from './UserTenantMembership.js';

const TENANT_A = TenantId.create(uuidAt(1000)).getValue();

describe('UserTenantMembership', () => {
  it('grant() cree un membership ACTIF avec les roles initiaux et emet MembershipGranted + MembershipRoleAssigned', () => {
    const clock = new FixedClock('2026-08-23T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const membership = UserTenantMembership.grant({
      userId: idFor.userAccount(1),
      tenantId: TENANT_A,
      createdBy: idFor.userAccount(2),
      initialRoleIds: [idFor.role(1), idFor.role(2)],
      clock,
      idGenerator,
    });

    expect(membership.status).toBe('ACTIVE');
    expect(membership.isActive()).toBe(true);
    expect(membership.roleIds).toHaveLength(2);

    const events = membership.pullDomainEvents();
    expect(events.map((event) => event.eventType)).toEqual([
      'identity.membership.granted',
      'identity.membership.role-assigned',
      'identity.membership.role-assigned',
    ]);
  });

  it('assignRole ajoute un role et est idempotent si le role est deja porte', () => {
    const clock = new FixedClock('2026-08-23T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const membership = UserTenantMembership.grant({
      userId: idFor.userAccount(1),
      tenantId: TENANT_A,
      createdBy: idFor.userAccount(2),
      initialRoleIds: [idFor.role(1)],
      clock,
      idGenerator,
    });
    membership.pullDomainEvents();

    const result = membership.assignRole(idFor.role(2), clock, idGenerator);
    expect(result.isSuccess()).toBe(true);
    expect(membership.roleIds).toHaveLength(2);

    // Un role deja porte n'est pas duplique et n'emet pas de second evenement.
    const again = membership.assignRole(idFor.role(2), clock, idGenerator);
    expect(again.isSuccess()).toBe(true);
    expect(membership.roleIds).toHaveLength(2);
    expect(membership.pullDomainEvents()).toHaveLength(1);
  });

  it('assignRole echoue sur un membership non actif', () => {
    const clock = new FixedClock('2026-08-23T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const membership = UserTenantMembership.grant({
      userId: idFor.userAccount(1),
      tenantId: TENANT_A,
      createdBy: idFor.userAccount(2),
      initialRoleIds: [],
      clock,
      idGenerator,
    });
    membership.suspend();

    const result = membership.assignRole(idFor.role(1), clock, idGenerator);
    expect(result.isFailure()).toBe(true);
    expect(result.getError().name).toBe('MembershipNotActiveError');
  });

  it('removeRole retire un role et emet MembershipRoleUnassigned', () => {
    const clock = new FixedClock('2026-08-23T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const membership = UserTenantMembership.grant({
      userId: idFor.userAccount(1),
      tenantId: TENANT_A,
      createdBy: idFor.userAccount(2),
      initialRoleIds: [idFor.role(1), idFor.role(2)],
      clock,
      idGenerator,
    });
    membership.pullDomainEvents();

    membership.removeRole(idFor.role(1), clock, idGenerator);
    expect(membership.roleIds).toHaveLength(1);
    expect(membership.roleIds[0]?.equals(idFor.role(2))).toBe(true);
    expect(membership.pullDomainEvents().map((e) => e.eventType)).toEqual([
      'identity.membership.role-unassigned',
    ]);
  });

  it('revoke() passe le statut a REVOKED, fixe leftAt et emet MembershipRevoked', () => {
    const clock = new FixedClock('2026-08-23T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const membership = UserTenantMembership.grant({
      userId: idFor.userAccount(1),
      tenantId: TENANT_A,
      createdBy: idFor.userAccount(2),
      initialRoleIds: [],
      clock,
      idGenerator,
    });
    membership.pullDomainEvents();

    clock.advanceMs(60_000);
    const result = membership.revoke(clock, idGenerator);

    expect(result.isSuccess()).toBe(true);
    expect(membership.status).toBe('REVOKED');
    expect(membership.isActive()).toBe(false);
    expect(membership.leftAt).toEqual(new Date('2026-08-23T10:01:00Z'));
    expect(membership.pullDomainEvents().map((e) => e.eventType)).toEqual(['identity.membership.revoked']);
  });

  it('revoke() sur un membership deja revoque echoue (idempotence explicite)', () => {
    const clock = new FixedClock('2026-08-23T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const membership = UserTenantMembership.grant({
      userId: idFor.userAccount(1),
      tenantId: TENANT_A,
      createdBy: idFor.userAccount(2),
      initialRoleIds: [],
      clock,
      idGenerator,
    });
    membership.revoke(clock, idGenerator);

    const second = membership.revoke(clock, idGenerator);
    expect(second.isFailure()).toBe(true);
    expect(second.getError().name).toBe('MembershipAlreadyRevokedError');
  });
});
