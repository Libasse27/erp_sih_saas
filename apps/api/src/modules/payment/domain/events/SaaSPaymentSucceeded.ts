import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis quand un paiement d'abonnement SaaS est CONFIRME (webhook signe valide OU rapprochement
 * periodique — jamais un retour frontend, O-25.5). C'est le "`SaaSPaymentSucceeded`" du
 * catalogue O-25.6 : consomme par le module `subscription`
 * (`ReactivateSubscriptionOnPaymentSucceeded.ts`) pour sortir l'abonnement de grace/mode degrade
 * "a tout moment", et par ce module lui-meme (`MarkPlatformInvoicePaidOnPaymentSucceeded.ts`)
 * pour marquer la facture payee. Porte les champs necessaires aux DEUX consommateurs SANS qu'ils
 * aient besoin d'importer le domain/ de ce module (Published Language, §5.1).
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
    this.providerTransactionId = params.providerTransactionId;
    this.newPeriodStartsAt = params.newPeriodStartsAt;
    this.newPeriodEndsAt = params.newPeriodEndsAt;
  }

  static create(params: {
    paymentId: string;
    tenantId: string;
    platformInvoiceId: string;
    subscriptionId: string;
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
      providerTransactionId: params.providerTransactionId,
      newPeriodStartsAt: params.newPeriodStartsAt.toISOString(),
      newPeriodEndsAt: params.newPeriodEndsAt.toISOString(),
    });
  }
}
