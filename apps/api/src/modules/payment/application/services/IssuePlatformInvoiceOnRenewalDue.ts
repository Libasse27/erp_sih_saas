import { z } from 'zod';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlatformInvoice } from '../../domain/PlatformInvoice.js';
import type { PlatformInvoiceRepository } from '../../domain/ports/PlatformInvoiceRepository.js';

/** Forme attendue du payload de `subscription.subscription.renewal-due` (module `subscription`) — voir le commentaire equivalent dans ReactivateSubscriptionOnPaymentSucceeded.ts sur la raison d'un schema de frontiere ici. */
const SubscriptionRenewalDuePayloadSchema = z
  .object({
    tenantId: z.string(),
    planPriceId: z.string(),
    amountXof: z.number().int().nonnegative(),
    newPeriodStartsAt: z.string(),
    newPeriodEndsAt: z.string(),
  })
  .passthrough();

/**
 * Consommateur Outbox de `SubscriptionRenewalDue` (module `subscription`) cote Payment : emet la
 * `PlatformInvoice` correspondant a la periode due (O-25.1). Toutes les factures issues de ce
 * chemin portent `purpose: 'RENEWAL'` (voir application/commands/InitiatePayment.ts) — ce module
 * n'implemente PAS de flux distinct pour une "premiere facture" hors renouvellement a cette
 * etape (residu documente : voir rapport de fin de tache).
 *
 * IDEMPOTENT PAR CONSTRUCTION, PAS par verification explicite ici : delegue entierement a
 * `PlatformInvoiceRepository.issue()`, dont le CONTRAT impose de renvoyer la facture existante en
 * cas de conflit sur `(subscriptionId, periodStartsAt)` (voir la contrainte UNIQUE en base) —
 * c'est cette barriere-la qui protege contre deux renouvellements concurrents pour la meme
 * periode, pas une verification prealable ici (qui serait de toute facon sujette a une course).
 */
export function createIssuePlatformInvoiceOnRenewalDueHandler(deps: {
  platformInvoiceRepository: PlatformInvoiceRepository;
  unitOfWork: UnitOfWork;
  clock: Clock;
  idGenerator: IdGenerator;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    const parsed = SubscriptionRenewalDuePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new Error(
        `Payload invalide pour ${envelope.eventType} (outbox message ${envelope.id}) : ${parsed.error.message}`,
      );
    }
    const payload = parsed.data;

    const tenantIdResult = TenantId.create(payload.tenantId);
    if (tenantIdResult.isFailure()) {
      throw new Error(`tenantId invalide dans le payload de ${envelope.eventType} (outbox message ${envelope.id}).`);
    }
    const tenantId = tenantIdResult.getValue();

    const amountResult = Money.fromXOF(payload.amountXof);
    if (amountResult.isFailure()) {
      throw new Error(`amountXof invalide dans le payload de ${envelope.eventType} (outbox message ${envelope.id}).`);
    }

    await deps.unitOfWork.withTransaction(
      async () => {
        const invoice = PlatformInvoice.issue({
          tenantId,
          subscriptionId: envelope.aggregateId,
          planPriceId: payload.planPriceId,
          // Explicite depuis la passe 2 : ce chemin n'est plus le seul a emettre des factures
          // (voir IssuePlatformInvoiceOnUpgradeRequested.ts). Aucune `sourceReference` ici — le
          // couple `(subscriptionId, purpose, periodStartsAt)` identifie deja une periode due.
          purpose: 'RENEWAL',
          amount: amountResult.getValue(),
          periodStartsAt: new Date(payload.newPeriodStartsAt),
          periodEndsAt: new Date(payload.newPeriodEndsAt),
          clock: deps.clock,
          idGenerator: deps.idGenerator,
        });
        await deps.platformInvoiceRepository.issue(invoice);
      },
      { tenantId },
    );
  };
}
