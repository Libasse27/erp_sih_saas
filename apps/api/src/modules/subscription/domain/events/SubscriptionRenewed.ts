import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis quand un paiement confirme couvre le renouvellement d'un abonnement encore `ACTIVE`
 * (jamais entre en grace) — distinct de `SubscriptionReactivated`, reserve a la sortie de
 * `GRACE_PERIOD`/`DEGRADED`. Correspond au libelle "RENOUVELE" du catalogue d'etats reutilise par
 * O-25.5 (voir Payment.status, meme nuance documentee).
 */
export class SubscriptionRenewed implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'subscription.subscription.renewed';
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
  }): SubscriptionRenewed {
    return new SubscriptionRenewed({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.subscriptionId,
      tenantId: params.tenantId,
      newPeriodStartsAt: params.newPeriodStartsAt.toISOString(),
      newPeriodEndsAt: params.newPeriodEndsAt.toISOString(),
    });
  }
}
