import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis au demarrage d'un abonnement (essai gratuit STANDARD, O-02.5). Consommateurs futurs
 * possibles (hors perimetre ici) : notification de bienvenue (etape 9), suivi commercial des
 * essais.
 */
export class SubscriptionStarted implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'subscription.subscription.started';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly planId: string;
  readonly trialEndsAt: string | null;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    planId: string;
    trialEndsAt: string | null;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.planId = params.planId;
    this.trialEndsAt = params.trialEndsAt;
  }

  static create(params: {
    subscriptionId: string;
    tenantId: string;
    planId: string;
    trialEndsAt: Date | null;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SubscriptionStarted {
    return new SubscriptionStarted({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.subscriptionId,
      tenantId: params.tenantId,
      planId: params.planId,
      trialEndsAt: params.trialEndsAt === null ? null : params.trialEndsAt.toISOString(),
    });
  }
}
