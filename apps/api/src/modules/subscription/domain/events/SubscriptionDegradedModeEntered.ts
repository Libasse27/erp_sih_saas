import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis a J+7 sans regularisation (O-03.2/O-25.6) : l'abonnement passe en mode degrade pour 30
 * jours. Rappel de l'invariant port par O-03.1 (non applique par ce module, qui ne connait que le
 * statut) : jamais de blocage de l'acces clinique, uniquement les fonctions
 * commerciales/administratives non essentielles.
 */
export class SubscriptionDegradedModeEntered implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'subscription.subscription.degraded-mode-entered';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly degradedModeEnteredAt: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    degradedModeEnteredAt: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.degradedModeEnteredAt = params.degradedModeEnteredAt;
  }

  static create(params: {
    subscriptionId: string;
    tenantId: string;
    degradedModeEnteredAt: Date;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SubscriptionDegradedModeEntered {
    return new SubscriptionDegradedModeEntered({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.subscriptionId,
      tenantId: params.tenantId,
      degradedModeEnteredAt: params.degradedModeEnteredAt.toISOString(),
    });
  }
}
