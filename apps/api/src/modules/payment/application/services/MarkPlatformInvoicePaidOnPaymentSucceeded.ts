import { z } from 'zod';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlatformInvoiceId } from '../../domain/value-objects/PlatformInvoiceId.js';
import type { PlatformInvoiceRepository } from '../../domain/ports/PlatformInvoiceRepository.js';

/** Forme attendue du payload de `payment.payment.saas-payment-succeeded` (voir domain/events/SaaSPaymentSucceeded.ts). */
const SaaSPaymentSucceededPayloadSchema = z
  .object({
    tenantId: z.string(),
    platformInvoiceId: z.string(),
  })
  .passthrough();

/**
 * Consommateur Outbox de `SaaSPaymentSucceeded` cote `PlatformInvoice` (meme evenement que
 * `subscription/application/services/ReactivateSubscriptionOnPaymentSucceeded.ts`, DEUX
 * consommateurs distincts, chacun dans SON PROPRE agregat/transaction — "une transaction = un
 * agregat", §9.2). IDEMPOTENT PAR CONSTRUCTION : delegue a `PlatformInvoice.markPaid()`, qui ne
 * fait rien si la facture est deja `PAID` (re-livraison at-least-once, D9).
 */
export function createMarkPlatformInvoicePaidOnPaymentSucceededHandler(deps: {
  platformInvoiceRepository: PlatformInvoiceRepository;
  unitOfWork: UnitOfWork;
  clock: Clock;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    const parsed = SaaSPaymentSucceededPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new Error(
        `Payload invalide pour ${envelope.eventType} (outbox message ${envelope.id}) : ${parsed.error.message}`,
      );
    }
    const payload = parsed.data;

    const tenantIdResult = TenantId.create(payload.tenantId);
    const invoiceIdResult = PlatformInvoiceId.create(payload.platformInvoiceId);
    if (tenantIdResult.isFailure() || invoiceIdResult.isFailure()) {
      throw new Error(`Identifiants invalides dans le payload de ${envelope.eventType} (outbox message ${envelope.id}).`);
    }
    const tenantId = tenantIdResult.getValue();
    const invoiceId = invoiceIdResult.getValue();

    await deps.unitOfWork.withTransaction(
      async () => {
        const invoice = await deps.platformInvoiceRepository.findById(invoiceId, tenantId);
        if (invoice === null) {
          return;
        }
        invoice.markPaid(deps.clock.now());
        await deps.platformInvoiceRepository.save(invoice, tenantId);
      },
      { tenantId },
    );
  };
}
