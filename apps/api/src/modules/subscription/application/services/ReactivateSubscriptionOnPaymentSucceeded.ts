import { z } from 'zod';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { SubscriptionId } from '../../domain/value-objects/SubscriptionId.js';
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository.js';

/**
 * Forme attendue du payload de l'evenement `payment.payment.saas-payment-succeeded` (module
 * `payment`, voir payment/domain/events/SaaSPaymentSucceeded.ts) — ce module ne peut PAS importer
 * le type de l'evenement lui-meme (regle dependency-cruiser `no-cross-module-domain-import`),
 * seul le CONTRAT DE PAYLOAD (Published Language, §5.1) est partage, et encore : sous forme d'un
 * schema valide a la frontiere, jamais suppose (regle §2 du system prompt — un payload Outbox,
 * potentiellement emis par un autre module/une version anterieure du schema d'evenement, est une
 * entree externe du point de vue de ce handler).
 */
const SaaSPaymentSucceededPayloadSchema = z
  .object({
    tenantId: z.string(),
    subscriptionId: z.string(),
    newPeriodStartsAt: z.string(),
    newPeriodEndsAt: z.string(),
  })
  .passthrough();

/**
 * Consommateur Outbox de `SaaSPaymentSucceeded` (module `payment`) cote Subscription — c'est LUI
 * qui realise "un `SaaSPaymentSucceeded` recu a tout moment declenche `SubscriptionReactivated`
 * immediatement" (O-25.6) : "immediatement" signifie ici "des que le relais Outbox traite le
 * message" (au plus le prochain cycle de polling, PAS "dans la meme transaction que le paiement"
 * — respecte "une transaction = un agregat", §9.2 : `Payment` et `Subscription` sont deux
 * agregats distincts, jamais mutes dans la meme transaction).
 *
 * IDEMPOTENT (obligatoire, at-least-once) : delegue entierement a `Subscription.reactivate()`/
 * `renew()`, qui sont eux-memes idempotents par construction (voir Subscription.ts) — rejouer ce
 * handler pour le meme evenement, ou pour un evenement en double, ne produit jamais de second
 * `SubscriptionReactivated`/`SubscriptionRenewed`.
 *
 * Branche sur le statut COURANT de l'abonnement au moment du traitement (pas sur une hypothese
 * figee au moment de l'emission de l'evenement, qui peut etre traite en retard) : `GRACE_PERIOD`/
 * `DEGRADED` -> `reactivate()` (emet `SubscriptionReactivated`) ; `ACTIVE`/`TRIALING` ->
 * `renew()` (emet `SubscriptionRenewed`, jamais entre en grace).
 */
export function createReactivateSubscriptionOnPaymentSucceededHandler(deps: {
  subscriptionRepository: SubscriptionRepository;
  unitOfWork: UnitOfWork;
  clock: Clock;
  idGenerator: IdGenerator;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    const parsed = SaaSPaymentSucceededPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      // Payload malforme : erreur de programmation/incompatibilite de version d'evenement, pas
      // un cas metier attendu — laisse le relais retenter/dead-letter (voir OutboxRelay.ts),
      // jamais un echec metier absorbe silencieusement.
      throw new Error(
        `Payload invalide pour ${envelope.eventType} (outbox message ${envelope.id}) : ${parsed.error.message}`,
      );
    }
    const payload = parsed.data;

    const tenantIdResult = TenantId.create(payload.tenantId);
    const subscriptionIdResult = SubscriptionId.create(payload.subscriptionId);
    if (tenantIdResult.isFailure() || subscriptionIdResult.isFailure()) {
      throw new Error(`Identifiants invalides dans le payload de ${envelope.eventType} (outbox message ${envelope.id}).`);
    }
    const tenantId = tenantIdResult.getValue();
    const subscriptionId = subscriptionIdResult.getValue();
    const newPeriodStartsAt = new Date(payload.newPeriodStartsAt);
    const newPeriodEndsAt = new Date(payload.newPeriodEndsAt);

    await deps.unitOfWork.withTransaction(
      async () => {
        const subscription = await deps.subscriptionRepository.findById(subscriptionId, tenantId);
        if (subscription === null) {
          // Abonnement introuvable pour ce tenant : ne devrait pas arriver (le paiement porte
          // deja un subscriptionId valide au moment de son emission) — trace mais n'echoue pas
          // le message (evite un dead-letter infini sur une incoherence non recuperable ici).
          return;
        }

        if (subscription.status === 'GRACE_PERIOD' || subscription.status === 'DEGRADED') {
          subscription.reactivate({ newPeriodStartsAt, newPeriodEndsAt, clock: deps.clock, idGenerator: deps.idGenerator });
        } else {
          subscription.renew({ newPeriodStartsAt, newPeriodEndsAt, clock: deps.clock, idGenerator: deps.idGenerator });
        }

        await deps.subscriptionRepository.save(subscription, tenantId);
      },
      { tenantId },
    );
  };
}
