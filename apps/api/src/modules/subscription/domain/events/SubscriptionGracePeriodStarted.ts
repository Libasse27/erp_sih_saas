import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis quand un abonnement entre en periode de grace (O-03.2 : 7 jours, echeance depassee sans
 * paiement confirme). Point d'extension explicitement prevu pour les 3 rappels (O-03.2/O-07,
 * calendrier exact en residu) — cet evenement suffit comme hook, aucun envoi de notification
 * n'est implemente ici (hors perimetre de cette etape).
 */
export class SubscriptionGracePeriodStarted implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'subscription.subscription.grace-period-started';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly gracePeriodStartedAt: string;
  readonly graceEndsAt: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    gracePeriodStartedAt: string;
    graceEndsAt: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.gracePeriodStartedAt = params.gracePeriodStartedAt;
    this.graceEndsAt = params.graceEndsAt;
  }

  static create(params: {
    subscriptionId: string;
    tenantId: string;
    gracePeriodStartedAt: Date;
    graceEndsAt: Date;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SubscriptionGracePeriodStarted {
    return new SubscriptionGracePeriodStarted({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.subscriptionId,
      tenantId: params.tenantId,
      gracePeriodStartedAt: params.gracePeriodStartedAt.toISOString(),
      graceEndsAt: params.graceEndsAt.toISOString(),
    });
  }
}
