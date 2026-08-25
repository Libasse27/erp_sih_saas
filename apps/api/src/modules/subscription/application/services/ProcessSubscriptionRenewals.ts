import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { addBillingPeriod } from '../../domain/services/CalendarDays.js';
import type { PlanPriceRepository } from '../../domain/ports/PlanPriceRepository.js';
import {
  SubscriptionConcurrencyConflictError,
  type SubscriptionRepository,
} from '../../domain/ports/SubscriptionRepository.js';

export interface ProcessSubscriptionRenewalsResult {
  readonly scanned: number;
  readonly renewalsDue: number;
  readonly gracePeriodsStarted: number;
  readonly degradedModeEntries: number;
  readonly degradedModeSustainedNotifications: number;
  /** Abonnements sautes ce cycle pour cause d'ecriture concurrente (voir le commentaire de `execute`) — le prochain tick les reevaluera. */
  readonly skippedOnConflict: number;
}

/**
 * Ce qui a effectivement ete applique a UN abonnement dans son cycle. Retourne par la transaction
 * plutot qu'incremente a l'interieur : un conflit de verrouillage optimiste annule la transaction,
 * et des compteurs deja incrementes rapporteraient alors un travail qui n'a jamais ete commite.
 */
type CycleOutcome = 'RENEWAL_DUE' | 'DEGRADED_ENTERED' | 'SUSTAIN_NOTIFIED' | 'NONE';

/**
 * Scheduler autonome de renouvellement d'abonnement (O-25.6, catalogue d'evenements) —
 * ***PAS un webhook*** : c'est CE processus, invoque periodiquement
 * (`infrastructure/scheduler/SubscriptionRenewalScheduler.ts`), qui pilote le declenchement de la
 * grace/mode degrade a l'echeance. Une panne totale du webhook PSP ne laisse donc jamais un
 * etablissement impaye indefiniment en acces complet (exigence explicite O-25.6/§6.3) : ce
 * handler ne consulte JAMAIS `Payment`/`PlatformInvoice` (module `payment`, domain/ non
 * importable ici — regle dependency-cruiser `no-cross-module-domain-import`), il ne s'appuie que
 * sur l'etat interne de `Subscription` (statut + horodatages de grace/degrade), pilote lui-meme
 * par la confirmation de paiement via `Subscription.reactivate()`/`renew()` (voir module
 * `subscription/application/services/ReactivateSubscriptionOnPaymentSucceeded.ts`).
 *
 * Catalogue applique tel quel (01-target-architecture.md §6.3, copie litterale) :
 *   SubscriptionRenewalDue (ce scheduler) -> aucun SUCCEEDED confirme -> SubscriptionGracePeriodStarted
 *   -> J+7 sans regularisation -> SubscriptionDegradedModeEntered
 *   -> J+37 sans regularisation -> SubscriptionDegradedModeSustained (maintien indefini)
 *
 * POINT SIGNALE A L'ARCHITECTE (interpretation non totalement contrainte par l'ADR) : la grace
 * demarre ICI IMMEDIATEMENT des que l'echeance est atteinte (`isRenewalDue`), dans le MEME cycle
 * que `SubscriptionRenewalDue` — puisque, par construction, un abonnement dont c'est la PREMIERE
 * fois qu'il est vu en echeance n'a par definition encore aucun paiement confirme pour la
 * nouvelle periode. Le texte du catalogue les enchaine sans intervalle explicite entre les deux;
 * un adversarial test fourni ("le scheduler doit declencher la grace a J+7") suggere une lecture
 * alternative (grace demarree seulement 7 jours apres l'echeance) qui contredirait alors la place
 * de "J+7" pour la transition SUIVANTE (grace -> degrade) dans le MEME catalogue. La lecture
 * retenue ici est la plus litterale du texte source (01-target-architecture.md §6.3), mais le
 * point merite une confirmation explicite.
 *
 * Traite CHAQUE abonnement candidat dans SA PROPRE transaction ("une transaction = un agregat",
 * 01-target-architecture.md §9.2) — un echec sur l'un n'affecte jamais les autres, et deux
 * executions concurrentes de ce scheduler (deux instances du processus, ou un chevauchement
 * malgre `PeriodicJobRunner`) restent sans consequence metier grave : au pire, `Subscription`
 * emet deux fois le meme evenement `SubscriptionRenewalDue`/`SubscriptionGracePeriodStarted` pour
 * le meme cycle (pas de verrou pessimiste sur la ligne, limite connue — voir rapport de fin de
 * tache), mais la contrainte UNIQUE `PlatformInvoice(subscriptionId, periodStartsAt)`
 * (module `payment`) empeche toute double facturation qui en decoulerait : c'est cette barriere
 * la, pas un verrou ici, qui rend l'ensemble idempotent bout en bout.
 */
export class ProcessSubscriptionRenewalsHandler {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly planPriceRepository: PlanPriceRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  /**
   * SAUTE un abonnement (et lui seul) en cas d'ecriture concurrente perdue
   * (`SubscriptionConcurrencyConflictError`, voir domain/ports/SubscriptionRepository.ts) plutot
   * que de faire echouer tout le lot : un autre writer (confirmation de paiement, application d'un
   * upgrade paye) vient d'ecrire cet abonnement, et son etat n'est plus celui sur lequel ce cycle
   * a raisonne. AUCUN retry immediat ici, contrairement aux consommateurs Outbox : ce scheduler
   * repasse periodiquement et toutes les transitions de `Subscription` sont gardees/idempotentes —
   * le prochain tick reevaluera l'abonnement sur un etat frais, ce qui est plus sur que de
   * reappliquer des decisions prises sur une lecture perimee.
   */
  async execute(): Promise<ProcessSubscriptionRenewalsResult> {
    const now = this.clock.now();
    const candidates = await this.subscriptionRepository.listSchedulerCandidates(now);

    let renewalsDue = 0;
    let gracePeriodsStarted = 0;
    let degradedModeEntries = 0;
    let degradedModeSustainedNotifications = 0;
    let skippedOnConflict = 0;

    for (const candidate of candidates) {
      let outcome: CycleOutcome;
      try {
        outcome = await this.unitOfWork.withTransaction(
          async (): Promise<CycleOutcome> => {
            const subscription = await this.subscriptionRepository.findById(candidate.id, candidate.tenantId);
            if (subscription === null) {
              return 'NONE';
            }

            let cycleOutcome: CycleOutcome;

            if (subscription.isRenewalDue(now)) {
              const currentPrice = await this.planPriceRepository.findById(subscription.currentPlanPriceId);
              if (currentPrice === null) {
                throw new Error(
                  `PlanPrice ${subscription.currentPlanPriceId.toString()} introuvable pour l'abonnement ${subscription.id.toString()} (etat incoherent, append-only).`,
                );
              }
              const newPeriodStartsAt = subscription.periodEndsAt;
              const newPeriodEndsAt = addBillingPeriod(newPeriodStartsAt, subscription.period);

              subscription.markRenewalDue({
                amountXof: currentPrice.amount.amount,
                newPeriodStartsAt,
                newPeriodEndsAt,
                clock: this.clock,
                idGenerator: this.idGenerator,
              });
              subscription.startGracePeriod({ now, clock: this.clock, idGenerator: this.idGenerator });
              cycleOutcome = 'RENEWAL_DUE';
            } else if (subscription.isGracePeriodExpired(now)) {
              subscription.enterDegradedMode({ now, clock: this.clock, idGenerator: this.idGenerator });
              cycleOutcome = 'DEGRADED_ENTERED';
            } else if (subscription.isDegradedModeSustainDue(now)) {
              subscription.sustainDegradedMode({ clock: this.clock, idGenerator: this.idGenerator });
              cycleOutcome = 'SUSTAIN_NOTIFIED';
            } else {
              return 'NONE';
            }

            await this.subscriptionRepository.save(subscription, subscription.tenantId);
            return cycleOutcome;
          },
          { tenantId: candidate.tenantId },
        );
      } catch (error) {
        if (!(error instanceof SubscriptionConcurrencyConflictError)) {
          throw error;
        }
        skippedOnConflict += 1;
        continue;
      }

      if (outcome === 'RENEWAL_DUE') {
        renewalsDue += 1;
        gracePeriodsStarted += 1;
      } else if (outcome === 'DEGRADED_ENTERED') {
        degradedModeEntries += 1;
      } else if (outcome === 'SUSTAIN_NOTIFIED') {
        degradedModeSustainedNotifications += 1;
      }
    }

    return {
      scanned: candidates.length,
      renewalsDue,
      gracePeriodsStarted,
      degradedModeEntries,
      degradedModeSustainedNotifications,
      skippedOnConflict,
    };
  }
}
