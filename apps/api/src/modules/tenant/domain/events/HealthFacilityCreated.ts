import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis a la creation d'un `HealthFacility`, c'est-a-dire a la naissance du tenant lui-meme.
 * `tenantId` = `aggregateId` (le HealthFacility EST le tenant, voir HealthFacility.ts) —
 * contrairement aux evenements Identity ou `tenantId` designe un tenant distinct de l'agregat
 * qui emet l'evenement.
 */
export class HealthFacilityCreated implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'tenant.health-facility.created';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly name: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    name: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.aggregateId;
    this.name = params.name;
  }

  static create(params: {
    healthFacilityId: string;
    name: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): HealthFacilityCreated {
    return new HealthFacilityCreated({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.healthFacilityId,
      name: params.name,
    });
  }
}
