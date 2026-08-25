import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis quand un tenant DEMANDE un upgrade proratise — le forfait n'est PAS encore change a cet
 * instant (voir `Subscription.requestUpgrade`). Porte tout ce qu'il faut au module `payment` pour
 * emettre la facture correspondante (`IssuePlatformInvoiceOnUpgradeRequested.ts`) SANS jamais
 * importer le domain/ de ce module (regle dependency-cruiser `no-cross-module-domain-import`) :
 * le payload de cet evenement EST le contrat publie entre les deux modules ("Published Language"),
 * exactement comme `SubscriptionRenewalDue` pour le chemin de renouvellement.
 *
 * `planChangeId` est l'identite PRE-ATTRIBUEE de la demande (voir PlanUpgradeRequest.ts) : le
 * module `payment` la conserve telle quelle comme `sourceReference` opaque de la facture, et la
 * restitue dans `SaaSPaymentSucceeded` — c'est le seul fil qui permet de rattacher, plus tard, un
 * paiement confirme a LA demande precise qu'il regle.
 *
 * `expiresAt` circule dans le payload bien qu'aucun consommateur actuel ne l'utilise : c'est une
 * information de contrat (la facture emise correspond a une intention limitee dans le temps), utile
 * a un futur consommateur de notification (relance avant expiration, etape 9) et sans cout ici.
 */
export class SubscriptionUpgradeRequested implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'subscription.subscription.upgrade-requested';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly planChangeId: string;
  readonly fromPlanId: string;
  readonly fromPlanPriceId: string;
  readonly toPlanId: string;
  readonly toPlanPriceId: string;
  readonly proratedAmountXof: number;
  readonly coveredPeriodStartsAt: string;
  readonly coveredPeriodEndsAt: string;
  readonly expiresAt: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    planChangeId: string;
    fromPlanId: string;
    fromPlanPriceId: string;
    toPlanId: string;
    toPlanPriceId: string;
    proratedAmountXof: number;
    coveredPeriodStartsAt: string;
    coveredPeriodEndsAt: string;
    expiresAt: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.planChangeId = params.planChangeId;
    this.fromPlanId = params.fromPlanId;
    this.fromPlanPriceId = params.fromPlanPriceId;
    this.toPlanId = params.toPlanId;
    this.toPlanPriceId = params.toPlanPriceId;
    this.proratedAmountXof = params.proratedAmountXof;
    this.coveredPeriodStartsAt = params.coveredPeriodStartsAt;
    this.coveredPeriodEndsAt = params.coveredPeriodEndsAt;
    this.expiresAt = params.expiresAt;
  }

  static create(params: {
    subscriptionId: string;
    tenantId: string;
    planChangeId: string;
    fromPlanId: string;
    fromPlanPriceId: string;
    toPlanId: string;
    toPlanPriceId: string;
    proratedAmountXof: number;
    coveredPeriodStartsAt: Date;
    coveredPeriodEndsAt: Date;
    expiresAt: Date;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SubscriptionUpgradeRequested {
    return new SubscriptionUpgradeRequested({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.subscriptionId,
      tenantId: params.tenantId,
      planChangeId: params.planChangeId,
      fromPlanId: params.fromPlanId,
      fromPlanPriceId: params.fromPlanPriceId,
      toPlanId: params.toPlanId,
      toPlanPriceId: params.toPlanPriceId,
      proratedAmountXof: params.proratedAmountXof,
      coveredPeriodStartsAt: params.coveredPeriodStartsAt.toISOString(),
      coveredPeriodEndsAt: params.coveredPeriodEndsAt.toISOString(),
      expiresAt: params.expiresAt.toISOString(),
    });
  }
}
