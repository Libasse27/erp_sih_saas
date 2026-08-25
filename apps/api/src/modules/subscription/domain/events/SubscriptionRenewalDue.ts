import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis par le scheduler (PAS un webhook — O-25.6/§6.3) quand `periodEndsAt` d'un abonnement est
 * atteinte. Porte le montant et la periode a facturer, resolus depuis `currentPlanPriceId` par
 * l'appelant (`ProcessSubscriptionRenewals.ts`, meme discipline O-02.6 que le reste du module :
 * jamais `plan.price` en direct) — c'est ce qui permet au consommateur (module `payment`,
 * `IssuePlatformInvoiceOnRenewalDue.ts`) d'emettre la facture SANS jamais importer le domain/ du
 * module Subscription (regle dependency-cruiser `no-cross-module-domain-import`) : le payload de
 * cet evenement EST le contrat publie entre les deux modules ("Published Language").
 */
export class SubscriptionRenewalDue implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'subscription.subscription.renewal-due';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly planPriceId: string;
  readonly amountXof: number;
  readonly newPeriodStartsAt: string;
  readonly newPeriodEndsAt: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    planPriceId: string;
    amountXof: number;
    newPeriodStartsAt: string;
    newPeriodEndsAt: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.planPriceId = params.planPriceId;
    this.amountXof = params.amountXof;
    this.newPeriodStartsAt = params.newPeriodStartsAt;
    this.newPeriodEndsAt = params.newPeriodEndsAt;
  }

  static create(params: {
    subscriptionId: string;
    tenantId: string;
    planPriceId: string;
    amountXof: number;
    newPeriodStartsAt: Date;
    newPeriodEndsAt: Date;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SubscriptionRenewalDue {
    return new SubscriptionRenewalDue({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.subscriptionId,
      tenantId: params.tenantId,
      planPriceId: params.planPriceId,
      amountXof: params.amountXof,
      newPeriodStartsAt: params.newPeriodStartsAt.toISOString(),
      newPeriodEndsAt: params.newPeriodEndsAt.toISOString(),
    });
  }
}
