import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis quand un paiement confirme (`SaaSPaymentSucceeded`, module `payment`) fait sortir un
 * abonnement de `GRACE_PERIOD`/`DEGRADED`, A TOUT MOMENT (O-25.6 : "sans attendre le prochain
 * controle programme") — jamais issu du scheduler, toujours declenche par la confirmation
 * serveur-a-serveur du paiement (webhook valide OU rapprochement periodique, jamais un retour
 * frontend).
 */
export class SubscriptionReactivated implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'subscription.subscription.reactivated';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly newPeriodStartsAt: string;
  readonly newPeriodEndsAt: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    newPeriodStartsAt: string;
    newPeriodEndsAt: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.newPeriodStartsAt = params.newPeriodStartsAt;
    this.newPeriodEndsAt = params.newPeriodEndsAt;
  }

  static create(params: {
    subscriptionId: string;
    tenantId: string;
    newPeriodStartsAt: Date;
    newPeriodEndsAt: Date;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SubscriptionReactivated {
    return new SubscriptionReactivated({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.subscriptionId,
      tenantId: params.tenantId,
      newPeriodStartsAt: params.newPeriodStartsAt.toISOString(),
      newPeriodEndsAt: params.newPeriodEndsAt.toISOString(),
    });
  }
}
