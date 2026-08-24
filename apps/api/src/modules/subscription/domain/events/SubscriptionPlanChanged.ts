import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis a chaque changement de forfait applique immediatement (upgrade proratise, O-02.6).
 * Consommateurs futurs possibles (hors perimetre ici) : facturation SaaS (etape 5, encaissement
 * du montant proratise), notification de confirmation (etape 9). Le montant proratise n'est PAS
 * porte par cet evenement — la source de verite du montant est la ligne d'historique
 * `PlanChange` persistee dans la meme transaction (voir domain/PlanChange.ts), jamais recalculee
 * depuis l'evenement.
 */
export class SubscriptionPlanChanged implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'subscription.subscription.plan-changed';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly fromPlanId: string;
  readonly toPlanId: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    fromPlanId: string;
    toPlanId: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.fromPlanId = params.fromPlanId;
    this.toPlanId = params.toPlanId;
  }

  static create(params: {
    subscriptionId: string;
    tenantId: string;
    fromPlanId: string;
    toPlanId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SubscriptionPlanChanged {
    return new SubscriptionPlanChanged({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.subscriptionId,
      tenantId: params.tenantId,
      fromPlanId: params.fromPlanId,
      toPlanId: params.toPlanId,
    });
  }
}
