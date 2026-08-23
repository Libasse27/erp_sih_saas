import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/** Emis quand un role supplementaire est attribue a un membership deja existant. */
export class MembershipRoleAssigned implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.membership.role-assigned';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly roleId: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    roleId: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.roleId = params.roleId;
  }

  static create(params: {
    membershipId: string;
    tenantId: string;
    roleId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): MembershipRoleAssigned {
    return new MembershipRoleAssigned({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.membershipId,
      tenantId: params.tenantId,
      roleId: params.roleId,
    });
  }
}
