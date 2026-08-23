import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/** Emis quand un `UserAccount` se voit accorder un `UserTenantMembership` sur un etablissement. */
export class MembershipGranted implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.membership.granted';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly userId: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    userId: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.userId = params.userId;
  }

  static create(params: {
    membershipId: string;
    tenantId: string;
    userId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): MembershipGranted {
    return new MembershipGranted({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.membershipId,
      tenantId: params.tenantId,
      userId: params.userId,
    });
  }
}
