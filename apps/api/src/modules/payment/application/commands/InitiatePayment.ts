import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { Payment } from '../../domain/Payment.js';
import type { PaymentRepository } from '../../domain/ports/PaymentRepository.js';
import type { PaymentProvider } from '../../domain/ports/PaymentProvider.js';
import type { PlatformInvoiceRepository } from '../../domain/ports/PlatformInvoiceRepository.js';
import { isPaymentMethod } from '../../domain/value-objects/PaymentMethod.js';
import type { PaymentPurpose } from '../../domain/value-objects/PaymentPurpose.js';
import { PlatformInvoiceId } from '../../domain/value-objects/PlatformInvoiceId.js';
import type { PlatformInvoicePurpose } from '../../domain/value-objects/PlatformInvoicePurpose.js';
import type { BillingAuditTrail } from '../ports/BillingAuditTrail.js';

/**
 * Mapping 1-1 entre la nature de la FACTURE et celle du PAIEMENT qui la regle. Deux enumerations
 * distinctes malgre des valeurs homonymes : `PlatformInvoicePurpose` ne declare que des chemins
 * d'emission REELLEMENT existants, tandis que `PaymentPurpose` porte en plus le residu `'INITIAL'`
 * documente dans son propre fichier. Ce mapping explicite est le seul point du code qui les relie,
 * et il est exhaustif par construction (le compilateur echoue si une valeur de facture apparait
 * sans traduction).
 */
function toPaymentPurpose(invoicePurpose: PlatformInvoicePurpose): PaymentPurpose {
  return invoicePurpose === 'UPGRADE' ? 'UPGRADE' : 'RENEWAL';
}

export interface InitiatePaymentCommand {
  readonly tenantId: string;
  readonly platformInvoiceId: string;
  readonly method: string;
}

export type InitiatePaymentError =
  | 'INVALID_TENANT_ID'
  | 'INVALID_PLATFORM_INVOICE_ID'
  | 'INVALID_METHOD'
  | 'INVOICE_NOT_FOUND'
  | 'INVOICE_ALREADY_PAID';

export interface InitiatePaymentResult {
  readonly paymentId: string;
  readonly providerTransactionId: string;
  readonly redirectUrl: string | null;
}

/**
 * Declenche une TENTATIVE de paiement pour une `PlatformInvoice` deja emise — Mobile Money ou
 * carte UNIQUEMENT (O-25.2, `isPaymentMethod` rend le virement inexprimable). Doit etre appele
 * EXPLICITEMENT (action commerciale/administrative, ou un futur job d'auto-charge si un
 * prestataire tokenise est retenu — O-25.3, non implemente a cette etape, voir
 * `PaymentProvider.ts`) : `IssuePlatformInvoiceOnRenewalDue` n'appelle JAMAIS cette commande
 * automatiquement.
 *
 * L'appel au prestataire (`PaymentProvider.initiatePayment`, I/O reseau) se fait EN DEHORS de la
 * transaction d'ecriture locale ("une transaction = un agregat", §9.2 — et §6.3 resilience :
 * jamais d'appel HTTP sortant tenu ouvert dans une transaction DB) : l'etat de la facture est
 * verifie une premiere fois avant l'appel externe, puis REVERIFIE dans la transaction qui
 * persiste le `Payment`, pour absorber une facture payee entre-temps par un autre chemin.
 *
 * `purpose` est DERIVE de `invoice.purpose` (voir `toPaymentPurpose` ci-dessus), jamais code en
 * dur : depuis la passe 2, deux chemins d'emission de facture coexistent (renouvellement/echeance
 * et upgrade proratise), et c'est la FACTURE qui porte la verite sur la nature de ce qui est du —
 * la deduire ici serait rejouer une decision deja prise en amont. `'INITIAL'` (PaymentPurpose)
 * reste non atteint par ce code (residu documente dans PaymentPurpose.ts).
 */
export class InitiatePaymentHandler {
  constructor(
    private readonly platformInvoiceRepository: PlatformInvoiceRepository,
    private readonly paymentRepository: PaymentRepository,
    private readonly paymentProvider: PaymentProvider,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly billingAuditTrail: BillingAuditTrail,
  ) {}

  async execute(command: InitiatePaymentCommand): Promise<Result<InitiatePaymentResult, InitiatePaymentError>> {
    const tenantIdResult = TenantId.create(command.tenantId);
    if (tenantIdResult.isFailure()) {
      return Result.failure('INVALID_TENANT_ID');
    }
    const tenantId = tenantIdResult.getValue();

    const invoiceIdResult = PlatformInvoiceId.create(command.platformInvoiceId);
    if (invoiceIdResult.isFailure()) {
      return Result.failure('INVALID_PLATFORM_INVOICE_ID');
    }
    const invoiceId = invoiceIdResult.getValue();

    if (!isPaymentMethod(command.method)) {
      return Result.failure('INVALID_METHOD');
    }
    const method = command.method;

    const invoiceBeforeCall = await this.platformInvoiceRepository.findById(invoiceId, tenantId);
    if (invoiceBeforeCall === null) {
      return Result.failure('INVOICE_NOT_FOUND');
    }
    if (invoiceBeforeCall.status === 'PAID') {
      return Result.failure('INVOICE_ALREADY_PAID');
    }

    const idempotencyKey = this.idGenerator.generate();
    const providerResult = await this.paymentProvider.initiatePayment({
      tenantId: command.tenantId,
      idempotencyKey,
      amount: invoiceBeforeCall.amount,
      method,
    });

    return this.unitOfWork.withTransaction(
      async () => {
        const invoice = await this.platformInvoiceRepository.findById(invoiceId, tenantId);
        if (invoice === null) {
          return Result.failure('INVOICE_NOT_FOUND');
        }
        if (invoice.status === 'PAID') {
          return Result.failure('INVOICE_ALREADY_PAID');
        }

        const payment = Payment.initiate({
          tenantId,
          platformInvoiceId: invoiceId,
          subscriptionId: invoice.subscriptionId,
          purpose: toPaymentPurpose(invoice.purpose),
          method,
          amount: invoice.amount,
          providerTransactionId: providerResult.providerTransactionId,
          clock: this.clock,
          idGenerator: this.idGenerator,
        });

        await this.paymentRepository.save(payment, tenantId);

        // ADR-0009 §2.2/§4 — meme transaction. `actorKind: 'SYSTEM'` : aucun endpoint HTTP
        // interactif n'invoque encore cette commande (voir le rapport de cette etape).
        await this.billingAuditTrail.record({
          eventType: 'BILLING_PAYMENT_INITIATED',
          outcome: 'SUCCESS',
          tenantId: tenantId.toString(),
          actorKind: 'SYSTEM',
          actorUserId: null,
          targetType: 'PAYMENT',
          targetId: payment.id.toString(),
          reason: null,
          sessionId: null,
          correlationId: null,
        });

        return Result.success({
          paymentId: payment.id.toString(),
          providerTransactionId: providerResult.providerTransactionId,
          redirectUrl: providerResult.redirectUrl,
        });
      },
      { tenantId },
    );
  }
}
