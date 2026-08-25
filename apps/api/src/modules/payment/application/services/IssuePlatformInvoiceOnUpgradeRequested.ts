import { z } from 'zod';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlatformInvoice } from '../../domain/PlatformInvoice.js';
import type { PlatformInvoiceRepository } from '../../domain/ports/PlatformInvoiceRepository.js';

/**
 * Forme attendue du payload de `subscription.subscription.upgrade-requested` (module
 * `subscription`) — meme discipline de schema de frontiere que
 * `IssuePlatformInvoiceOnRenewalDue.ts` : un payload Outbox emis par un AUTRE module est une
 * entree externe du point de vue de ce handler, jamais un type partage.
 *
 * `planChangeId` est traite ici comme une chaine OPAQUE, la "reference du fait metier a l'origine
 * de cette facture" : ce module ne sait pas, et n'a pas a savoir, qu'elle designe un changement de
 * forfait cote `subscription`.
 */
const SubscriptionUpgradeRequestedPayloadSchema = z
  .object({
    tenantId: z.string(),
    planChangeId: z.string(),
    toPlanPriceId: z.string(),
    proratedAmountXof: z.number().int().nonnegative(),
    coveredPeriodStartsAt: z.string(),
    coveredPeriodEndsAt: z.string(),
  })
  .passthrough();

/**
 * Consommateur Outbox de `SubscriptionUpgradeRequested` (module `subscription`) cote Payment :
 * emet la `PlatformInvoice` du montant PRORATISE d'un upgrade demande (O-02.6 + O-25.1). C'est
 * cette facture qui, une fois reglee et confirmee serveur-a-serveur, declenchera l'application
 * effective du changement de forfait — jamais l'inverse.
 *
 * Miroir exact d'`IssuePlatformInvoiceOnRenewalDue.ts`, y compris pour l'idempotence : elle est
 * IDEMPOTENTE PAR CONSTRUCTION, PAS par verification explicite ici. Elle est entierement deleguee
 * a `PlatformInvoiceRepository.issue()`, dont le CONTRAT impose de renvoyer la facture existante
 * en cas de conflit — ici sur la contrainte UNIQUE `source_reference` (au lieu de
 * `(subscriptionId, purpose, periodStartsAt)` pour le renouvellement). Une re-livraison Outbox
 * at-least-once du MEME `SubscriptionUpgradeRequested` ne peut donc jamais produire une seconde
 * facture, ni facturer deux fois le meme upgrade.
 *
 * `montant = 0` reste emis comme une facture normale : un upgrade demande le dernier jour d'une
 * periode peut legitimement se proratiser a zero (voir ProrationCalculator.ts, qui applique un
 * plancher de 1 FCFA uniquement au montant brut STRICTEMENT positif). L'application de l'upgrade
 * reste conditionnee a une confirmation de paiement, y compris dans ce cas : c'est le prestataire,
 * jamais ce code, qui decide comment une transaction de montant nul se confirme.
 */
export function createIssuePlatformInvoiceOnUpgradeRequestedHandler(deps: {
  platformInvoiceRepository: PlatformInvoiceRepository;
  unitOfWork: UnitOfWork;
  clock: Clock;
  idGenerator: IdGenerator;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    const parsed = SubscriptionUpgradeRequestedPayloadSchema.safeParse(envelope.payload);
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

    const amountResult = Money.fromXOF(payload.proratedAmountXof);
    if (amountResult.isFailure()) {
      throw new Error(
        `proratedAmountXof invalide dans le payload de ${envelope.eventType} (outbox message ${envelope.id}).`,
      );
    }

    await deps.unitOfWork.withTransaction(
      async () => {
        const invoice = PlatformInvoice.issue({
          tenantId,
          subscriptionId: envelope.aggregateId,
          planPriceId: payload.toPlanPriceId,
          purpose: 'UPGRADE',
          sourceReference: payload.planChangeId,
          amount: amountResult.getValue(),
          periodStartsAt: new Date(payload.coveredPeriodStartsAt),
          periodEndsAt: new Date(payload.coveredPeriodEndsAt),
          clock: deps.clock,
          idGenerator: deps.idGenerator,
        });
        await deps.platformInvoiceRepository.issue(invoice);
      },
      { tenantId },
    );
  };
}
