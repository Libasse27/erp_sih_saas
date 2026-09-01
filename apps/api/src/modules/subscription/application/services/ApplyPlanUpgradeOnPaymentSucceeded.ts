import { z } from 'zod';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlanChange } from '../../domain/PlanChange.js';
import type { Subscription } from '../../domain/Subscription.js';
import type { PlanChangeRepository } from '../../domain/ports/PlanChangeRepository.js';
import type { PlanUpgradeRequestRepository } from '../../domain/ports/PlanUpgradeRequestRepository.js';
import {
  SubscriptionConcurrencyConflictError,
  type SubscriptionRepository,
} from '../../domain/ports/SubscriptionRepository.js';
import type { SubscriptionAuditTrail } from '../ports/SubscriptionAuditTrail.js';

/**
 * Forme attendue du payload de `payment.payment.saas-payment-succeeded` (module `payment`) — meme
 * discipline de schema de frontiere que `ReactivateSubscriptionOnPaymentSucceeded.ts`.
 *
 * `purpose` et `sourceReference` sont declares OPTIONNELS bien qu'ils soient desormais toujours
 * emis : un message deja present dans l'Outbox, ecrit AVANT cette passe, ne les porte pas. Les
 * traiter comme obligatoires ferait echouer puis dead-letter ces messages-la, alors qu'ils ne
 * concernent par definition aucun upgrade (le chemin n'existait pas) et que ce handler doit
 * simplement les ignorer.
 */
const SaaSPaymentSucceededPayloadSchema = z
  .object({
    tenantId: z.string(),
    subscriptionId: z.string(),
    platformInvoiceId: z.string(),
    purpose: z.string().optional(),
    sourceReference: z.string().nullish(),
  })
  .passthrough();

/** Nombre d'essais de `save()` face a des conflits de verrouillage optimiste repetes — meme valeur et meme raisonnement que `ConfirmPayment.ts` (module `payment`). */
const MAX_SAVE_ATTEMPTS = 3;

export interface ApplyPlanUpgradeLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * Consommateur Outbox de `SaaSPaymentSucceeded` cote `Subscription`, DEDIE aux upgrades : c'est le
 * SEUL endroit du code qui appelle `Subscription.applyPlanUpgrade()`. Un upgrade proratise ne
 * devient effectif qu'ici, apres confirmation serveur-a-serveur du paiement (O-25.5) — la commande
 * de demande (`UpgradeSubscriptionPlan.ts`) ne peut PAS l'appliquer elle-meme.
 *
 * Se filtre LUI-MEME sur `purpose === 'UPGRADE'` plutot que d'etre aiguille par le registre du
 * composition-root : les TROIS consommateurs de cet evenement tournent sur CHAQUE
 * `SaaSPaymentSucceeded`, chacun ecartant ce qui ne le concerne pas. Le registre reste ainsi un
 * simple `eventType -> handlers[]`, sans logique de routage par contenu de payload qu'il faudrait
 * maintenir en double avec les handlers.
 *
 * IDEMPOTENT (at-least-once, D9), a trois niveaux : la garde no-op d'`applyPlanUpgrade()`, l'ecriture
 * de `PlanChange` idempotente par cle primaire (identifiant PRE-ATTRIBUE, voir
 * `domain/ports/PlanChangeRepository.ts`), et la detection explicite ci-dessous du cas "demande
 * absente mais PlanChange deja ecrit".
 *
 * ARBRE DE DECISION — trois voies menent a un "paiement orphelin", c'est-a-dire un paiement recu
 * qu'aucune application d'upgrade ne peut honorer sans risque financier :
 *   1. la demande n'existe plus ET aucun `PlanChange` ne porte cette reference : la demande a ete
 *      REMPLACEE par une autre (expiration + nouvelle demande) avant l'arrivee de ce paiement ;
 *   2. la demande retrouvee ne porte pas le meme `subscriptionId` que le paiement : incoherence de
 *      correlation, jamais appliquee ;
 *   3. le tarif actuel de l'abonnement a change depuis la demande
 *      (`currentPlanPriceId != fromPlanPriceId`) : un renouvellement ou un autre upgrade est passe
 *      entre-temps, la base de calcul du prorata paye est INVALIDEE. Appliquer quand meme
 *      reviendrait a vendre une montee en gamme au prix d'une autre.
 * Dans les trois cas : AUCUN effet d'etat, un log structure, et AUCUNE exception — le message
 * Outbox doit etre acquitte, pas retente indefiniment (il ne deviendra jamais traitable). La
 * regularisation est MANUELLE (remboursement automatique hors V1, O-25.1) : c'est une dette
 * assumee, tracee par ce log et par l'ADR-0003.
 */
export function createApplyPlanUpgradeOnPaymentSucceededHandler(deps: {
  subscriptionRepository: SubscriptionRepository;
  planUpgradeRequestRepository: PlanUpgradeRequestRepository;
  planChangeRepository: PlanChangeRepository;
  subscriptionAuditTrail: SubscriptionAuditTrail;
  unitOfWork: UnitOfWork;
  clock: Clock;
  idGenerator: IdGenerator;
  logger?: ApplyPlanUpgradeLogger;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    const parsed = SaaSPaymentSucceededPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new Error(
        `Payload invalide pour ${envelope.eventType} (outbox message ${envelope.id}) : ${parsed.error.message}`,
      );
    }
    const payload = parsed.data;

    // Ne concerne que les paiements d'upgrade. Un renouvellement/une reactivation est traite par
    // `ReactivateSubscriptionOnPaymentSucceeded.ts`, jamais ici.
    if (payload.purpose !== 'UPGRADE') {
      return;
    }

    const sourceReference = payload.sourceReference ?? null;
    if (sourceReference === null) {
      // Un paiement d'upgrade DOIT porter la reference de la demande qu'il regle (voir
      // PlatformInvoice.sourceReference) : sans elle, rien ne permet de savoir QUEL upgrade
      // appliquer — jamais de correlation de repli par `subscriptionId`, qui appliquerait
      // potentiellement un upgrade avec le prorata d'un autre.
      logUnmatchedPayment(deps.logger, {
        tenantId: payload.tenantId,
        subscriptionId: payload.subscriptionId,
        planChangeId: null,
        platformInvoiceId: payload.platformInvoiceId,
        reason: 'missing_source_reference',
      });
      return;
    }

    const tenantIdResult = TenantId.create(payload.tenantId);
    if (tenantIdResult.isFailure()) {
      throw new Error(`tenantId invalide dans le payload de ${envelope.eventType} (outbox message ${envelope.id}).`);
    }
    const tenantId = tenantIdResult.getValue();

    await deps.unitOfWork.withTransaction(
      async () => {
        const request = await deps.planUpgradeRequestRepository.findById(sourceReference, tenantId);

        if (request === null) {
          const alreadyApplied = await deps.planChangeRepository.findById(sourceReference, tenantId);
          if (alreadyApplied !== null) {
            // Re-livraison at-least-once d'un evenement DEJA traite : la demande a ete consommee
            // et l'historique ecrit. No-op silencieux, pas une anomalie.
            return;
          }
          logUnmatchedPayment(deps.logger, {
            tenantId: payload.tenantId,
            subscriptionId: payload.subscriptionId,
            planChangeId: sourceReference,
            platformInvoiceId: payload.platformInvoiceId,
            reason: 'request_replaced_or_unknown',
          });
          return;
        }

        if (request.subscriptionId.toString() !== payload.subscriptionId) {
          logUnmatchedPayment(deps.logger, {
            tenantId: payload.tenantId,
            subscriptionId: payload.subscriptionId,
            planChangeId: sourceReference,
            platformInvoiceId: payload.platformInvoiceId,
            reason: 'subscription_mismatch',
          });
          return;
        }

        const subscription = await deps.subscriptionRepository.findById(request.subscriptionId, tenantId);
        if (subscription === null) {
          logUnmatchedPayment(deps.logger, {
            tenantId: payload.tenantId,
            subscriptionId: payload.subscriptionId,
            planChangeId: sourceReference,
            platformInvoiceId: payload.platformInvoiceId,
            reason: 'subscription_not_found',
          });
          return;
        }

        if (!subscription.currentPlanPriceId.equals(request.fromPlanPriceId)) {
          logUnmatchedPayment(deps.logger, {
            tenantId: payload.tenantId,
            subscriptionId: payload.subscriptionId,
            planChangeId: sourceReference,
            platformInvoiceId: payload.platformInvoiceId,
            reason: 'proration_base_invalidated',
          });
          return;
        }

        // Nominal. Toutes les valeurs viennent de la demande FIGEE : aucun recalcul de prorata,
        // aucune relecture du catalogue — le tenant obtient exactement ce qu'il a paye.
        await saveWithConcurrencyRetry(deps, subscription, (current) =>
          current.applyPlanUpgrade({
            newPlanId: request.toPlanId,
            newPlanPriceId: request.toPlanPriceId,
            clock: deps.clock,
            idGenerator: deps.idGenerator,
          }),
        );

        await deps.planChangeRepository.append(
          PlanChange.create({
            id: request.id,
            subscriptionId: request.subscriptionId,
            tenantId,
            changeType: 'UPGRADE',
            fromPlanId: request.fromPlanId,
            fromPlanPriceId: request.fromPlanPriceId,
            toPlanId: request.toPlanId,
            toPlanPriceId: request.toPlanPriceId,
            proratedAmount: request.proratedAmount,
            requestedAt: request.requestedAt,
            platformInvoiceId: payload.platformInvoiceId,
            clock: deps.clock,
          }),
          tenantId,
        );

        // La demande a rempli son role : l'historique definitif est desormais `PlanChange`, et sa
        // suppression libere la contrainte UNIQUE `subscription_id` pour un futur upgrade.
        await deps.planUpgradeRequestRepository.delete(request.id.toString(), tenantId);

        // ADR-0009 §2.2/§4 — meme transaction. `actorKind: 'SYSTEM'` : consommateur Outbox qui
        // EXECUTE lui-meme la commande (autorise, §4) — jamais un traducteur d'evenement dedie.
        await deps.subscriptionAuditTrail.record({
          eventType: 'SUBSCRIPTION_PLAN_CHANGED',
          outcome: 'SUCCESS',
          tenantId: tenantId.toString(),
          actorKind: 'SYSTEM',
          actorUserId: null,
          targetId: subscription.id.toString(),
          reason: null,
          sessionId: null,
          correlationId: null,
        });
      },
      { tenantId },
    );
  };
}

/**
 * Applique `apply` (commande de domaine IDEMPOTENTE — voir `Subscription.applyPlanUpgrade`) puis
 * sauvegarde, en RETENTANT sur `SubscriptionConcurrencyConflictError` : un autre writer (scheduler
 * de renouvellement, reactivation sur paiement) a ecrit ce MEME abonnement entre notre lecture et
 * notre ecriture. On relit l'agregat FRAIS, on reapplique la meme commande (no-op si l'upgrade est
 * deja porte par l'etat relu) et on re-sauvegarde. Meme pattern que
 * `ConfirmPaymentHandler.saveWithConcurrencyRetry` (module `payment`) — duplique volontairement
 * plutot que factorise a travers les modules, chacun restant libre de faire evoluer sa politique.
 */
async function saveWithConcurrencyRetry(
  deps: { subscriptionRepository: SubscriptionRepository },
  subscription: Subscription,
  apply: (subscription: Subscription) => void,
): Promise<void> {
  let current = subscription;
  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
    apply(current);
    try {
      await deps.subscriptionRepository.save(current, current.tenantId);
      return;
    } catch (error) {
      if (!(error instanceof SubscriptionConcurrencyConflictError) || attempt === MAX_SAVE_ATTEMPTS) {
        throw error;
      }
      const reloaded = await deps.subscriptionRepository.findById(current.id, current.tenantId);
      if (reloaded === null) {
        // Ne devrait pas arriver : `current` existait a l'instant precedent (le conflit vient d'un
        // UPDATE concurrent, un Subscription n'est jamais supprime) — remonte l'erreur d'origine
        // plutot que de masquer une incoherence.
        throw error;
      }
      current = reloaded;
    }
  }
}

/**
 * Trace un paiement d'upgrade qu'aucune application ne peut honorer. Log de niveau `warn` : une
 * intervention humaine est requise (rapprochement comptable, eventuel geste commercial), mais le
 * systeme reste dans un etat coherent — l'abonnement conserve son forfait paye precedemment, aucune
 * capacite non reglee n'est ouverte. Aucune donnee personnelle n'y figure (regle §8.1).
 */
function logUnmatchedPayment(
  logger: ApplyPlanUpgradeLogger | undefined,
  fields: {
    tenantId: string;
    subscriptionId: string;
    planChangeId: string | null;
    platformInvoiceId: string;
    reason: string;
  },
): void {
  logger?.warn(
    { event: 'subscription.upgrade.unmatched_payment', ...fields },
    "Paiement d'upgrade sans demande applicable : regularisation manuelle requise",
  );
}
