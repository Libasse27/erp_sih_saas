import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { PaymentPurpose } from '../value-objects/PaymentPurpose.js';

/**
 * Emis quand un paiement d'abonnement SaaS est CONFIRME (webhook signe valide OU rapprochement
 * periodique — jamais un retour frontend, O-25.5). C'est le "`SaaSPaymentSucceeded`" du
 * catalogue O-25.6 : consomme par le module `subscription`
 * (`ReactivateSubscriptionOnPaymentSucceeded.ts` pour sortir l'abonnement de grace/mode degrade
 * "a tout moment", et depuis la passe 2 `ApplyPlanUpgradeOnPaymentSucceeded.ts` pour appliquer
 * enfin un upgrade proratise paye), et par ce module lui-meme
 * (`MarkPlatformInvoicePaidOnPaymentSucceeded.ts`) pour marquer la facture payee. Porte les champs
 * necessaires a TOUS ces consommateurs SANS qu'ils aient besoin d'importer le domain/ de ce module
 * (Published Language, §5.1).
 *
 * `eventVersion` reste a 1 malgre l'ajout de `purpose`/`sourceReference` a la passe 2 : ce sont
 * DEUX AJOUTS PUREMENT ADDITIFS, aucun champ existant n'est retire ni change de sens. Les
 * consommateurs valident deja leur payload par un schema Zod `.passthrough()` traitant ces deux
 * champs comme OPTIONNELS (voir les handlers concernes), ce qui garantit qu'un message deja
 * present dans l'Outbox, emis AVANT cette passe, reste traitable sans erreur. Incrementer la
 * version imposerait au contraire un aiguillage par version dans chaque consommateur, pour une
 * evolution qu'ils absorbent nativement.
 */
export class SaaSPaymentSucceeded implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'payment.payment.saas-payment-succeeded';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly platformInvoiceId: string;
  readonly subscriptionId: string;
  readonly purpose: PaymentPurpose;
  /** Reference opaque restituee telle quelle depuis la `PlatformInvoice` liee (voir PlatformInvoice.ts) — `null` pour un renouvellement. */
  readonly sourceReference: string | null;
  readonly providerTransactionId: string;
  readonly newPeriodStartsAt: string;
  readonly newPeriodEndsAt: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    platformInvoiceId: string;
    subscriptionId: string;
    purpose: PaymentPurpose;
    sourceReference: string | null;
    providerTransactionId: string;
    newPeriodStartsAt: string;
    newPeriodEndsAt: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.platformInvoiceId = params.platformInvoiceId;
    this.subscriptionId = params.subscriptionId;
    this.purpose = params.purpose;
    this.sourceReference = params.sourceReference;
    this.providerTransactionId = params.providerTransactionId;
    this.newPeriodStartsAt = params.newPeriodStartsAt;
    this.newPeriodEndsAt = params.newPeriodEndsAt;
  }

  static create(params: {
    paymentId: string;
    tenantId: string;
    platformInvoiceId: string;
    subscriptionId: string;
    purpose: PaymentPurpose;
    sourceReference: string | null;
    providerTransactionId: string;
    newPeriodStartsAt: Date;
    newPeriodEndsAt: Date;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SaaSPaymentSucceeded {
    return new SaaSPaymentSucceeded({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.paymentId,
      tenantId: params.tenantId,
      platformInvoiceId: params.platformInvoiceId,
      subscriptionId: params.subscriptionId,
      purpose: params.purpose,
      sourceReference: params.sourceReference,
      providerTransactionId: params.providerTransactionId,
      newPeriodStartsAt: params.newPeriodStartsAt.toISOString(),
      newPeriodEndsAt: params.newPeriodEndsAt.toISOString(),
    });
  }
}
