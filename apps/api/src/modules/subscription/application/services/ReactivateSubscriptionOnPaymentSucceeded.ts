import { z } from 'zod';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { Subscription } from '../../domain/Subscription.js';
import { SubscriptionId } from '../../domain/value-objects/SubscriptionId.js';
import {
  SubscriptionConcurrencyConflictError,
  type SubscriptionRepository,
} from '../../domain/ports/SubscriptionRepository.js';

/** Nombre d'essais de `save()` face a des conflits de verrouillage optimiste repetes — meme valeur et meme raisonnement que `ApplyPlanUpgradeOnPaymentSucceeded.ts`. */
const MAX_SAVE_ATTEMPTS = 3;

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
    // OPTIONNEL bien que toujours emis depuis la passe 2 : un message deja present dans l'Outbox,
    // ecrit avant cette passe, ne le porte pas — et il ne peut par definition concerner un upgrade.
    purpose: z.string().optional(),
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
 *
 * IGNORE les paiements d'UPGRADE (`purpose === 'UPGRADE'`, voir la garde ci-dessous) : le montant
 * proratise d'une montee en gamme ne regle PAS une periode de facturation. Le prendre pour un
 * renouvellement prolongerait `periodEndsAt` d'un cycle entier contre un paiement partiel, ou
 * sortirait de grace un compte qui n'a pas regle son impaye. Ce cas est traite exclusivement par
 * `ApplyPlanUpgradeOnPaymentSucceeded.ts`, qui ne touche lui jamais a la periode.
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

    // Voir le commentaire de tete : un paiement d'upgrade ne renouvelle ni ne reactive rien.
    if (payload.purpose === 'UPGRADE') {
      return;
    }

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

        await saveWithConcurrencyRetry(deps.subscriptionRepository, subscription, (current) => {
          // Le statut est relu sur l'agregat COURANT a chaque tentative (et non capture une fois
          // avant la boucle) : apres un conflit, l'etat relu peut avoir change de branche — un
          // abonnement lu `GRACE_PERIOD` peut avoir ete reactive entre-temps par un autre writer.
          if (current.status === 'GRACE_PERIOD' || current.status === 'DEGRADED') {
            current.reactivate({ newPeriodStartsAt, newPeriodEndsAt, clock: deps.clock, idGenerator: deps.idGenerator });
          } else {
            current.renew({ newPeriodStartsAt, newPeriodEndsAt, clock: deps.clock, idGenerator: deps.idGenerator });
          }
        });
      },
      { tenantId },
    );
  };
}

/**
 * Applique `apply` (commandes de domaine IDEMPOTENTES — `reactivate()`/`renew()`, voir
 * Subscription.ts) puis sauvegarde, en RETENTANT sur `SubscriptionConcurrencyConflictError` : le
 * scheduler de renouvellement ou l'application d'un upgrade paye peuvent ecrire ce MEME abonnement
 * entre notre lecture et notre ecriture. On relit l'agregat FRAIS, on reapplique la meme commande
 * (no-op si l'etat relu couvre deja la periode visee) et on re-sauvegarde. Meme pattern que
 * `ApplyPlanUpgradeOnPaymentSucceeded.ts`.
 */
async function saveWithConcurrencyRetry(
  subscriptionRepository: SubscriptionRepository,
  subscription: Subscription,
  apply: (subscription: Subscription) => void,
): Promise<void> {
  let current = subscription;
  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
    apply(current);
    try {
      await subscriptionRepository.save(current, current.tenantId);
      return;
    } catch (error) {
      if (!(error instanceof SubscriptionConcurrencyConflictError) || attempt === MAX_SAVE_ATTEMPTS) {
        throw error;
      }
      const reloaded = await subscriptionRepository.findById(current.id, current.tenantId);
      if (reloaded === null) {
        // Ne devrait pas arriver (un Subscription n'est jamais supprime) — remonte l'erreur
        // d'origine plutot que de masquer une incoherence.
        throw error;
      }
      current = reloaded;
    }
  }
}
