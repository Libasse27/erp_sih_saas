import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis UNE SEULE FOIS a J+37 sans regularisation (O-03.3) : le mode degrade est desormais
 * maintenu INDEFINIMENT, sans restriction clinique supplementaire ni suspension complete — le
 * recouvrement au-dela releve du commercial/contractuel (voir `Subscription.sustainDegradedMode`
 * pour la garde d'idempotence qui empeche une re-emission a chaque cycle du scheduler).
 */
export class SubscriptionDegradedModeSustained implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'subscription.subscription.degraded-mode-sustained';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;

  private constructor(params: { eventId: string; occurredAt: Date; aggregateId: string; tenantId: string }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
  }

  static create(params: {
    subscriptionId: string;
    tenantId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SubscriptionDegradedModeSustained {
    return new SubscriptionDegradedModeSustained({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.subscriptionId,
      tenantId: params.tenantId,
    });
  }
}
