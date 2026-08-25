import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { Payment } from '../../domain/Payment.js';
import { PaymentConcurrencyConflictError, type PaymentRepository } from '../../domain/ports/PaymentRepository.js';
import type { PlatformInvoiceRepository } from '../../domain/ports/PlatformInvoiceRepository.js';
import type { PaymentProvider } from '../../domain/ports/PaymentProvider.js';

/** Ne rapproche que les tentatives assez anciennes : evite de solliciter le prestataire pour un paiement initie il y a quelques secondes (le webhook a le temps d'arriver). */
const RECONCILE_AFTER_MINUTES = 5;

/** Au-dela de cette duree sans confirmation NI echec explicite du prestataire, la tentative est consideree abandonnee (EXPIRED) — evite un `Payment` PENDING indefiniment si le prestataire ne notifie jamais rien. */
const EXPIRE_AFTER_MINUTES = 60;

/**
 * Nombre d'essais de `save()` avant d'abandonner face a des conflits de verrouillage optimiste
 * repetes — meme raisonnement et meme valeur que `ConfirmPayment.ts` (voir ce fichier) : les DEUX
 * writers du MEME `Payment` (webhook de confirmation vs ce rapprochement periodique) appliquent
 * la meme discipline de retry borne.
 */
const MAX_SAVE_ATTEMPTS = 3;

export interface ReconcilePendingPaymentsResult {
  readonly reconciled: number;
  readonly confirmedSucceeded: number;
  readonly confirmedFailed: number;
  readonly expired: number;
}

/**
 * Rapprochement periodique (O-25.5 : "le webhook n'est jamais l'unique source de verite") —
 * interroge directement l'API du prestataire (`PaymentProvider.reconcileTransaction`) pour
 * chaque `Payment` encore `PENDING` depassant `RECONCILE_AFTER_MINUTES`, rattrape les
 * webhooks perdus (panne reseau, PSP qui ne notifie jamais). IDEMPOTENT (delegue a
 * `Payment.confirmSucceeded`/`confirmFailed`/`markExpired`, tous idempotents par construction).
 *
 * Comme `ProcessSubscriptionRenewals.ts` : une transaction par agregat trouve, jamais un lot
 * entier dans une seule transaction.
 *
 * RACE REELLE avec `ConfirmPaymentHandler` (webhook, voir ConfirmPayment.ts) : ce job peut lire un
 * `Payment` PENDING, puis s'appreter a le marquer EXPIRED, PENDANT qu'un webhook concurrent le
 * fait deja passer a SUCCEEDED/RENEWED — sans protection, le dernier `save()` gagnant ecraserait
 * silencieusement l'autre (lost update), alors qu'un evenement `SaaSPaymentSucceeded` aurait deja
 * ete ecrit dans l'Outbox par le webhook (incoherence Payment/Outbox). `save()` (voir
 * `PrismaPaymentRepository.ts`) leve `PaymentConcurrencyConflictError` dans ce cas — voir
 * `saveWithConcurrencyRetry` plus bas, qui relit/reapplique/re-sauvegarde plutot que d'ecraser.
 *
 * PAS de controle de montant ici (contrairement a `ConfirmPayment.ts`, §4 "AMOUNT_MISMATCH") :
 * residu documente explicitement — `ProviderTransactionStatus` (le contrat de
 * `reconcileTransaction()`) ne porte aucun montant, ce controle est structurellement impossible a
 * cette etape avec ce port.
 */
export class ReconcilePendingPaymentsHandler {
  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly platformInvoiceRepository: PlatformInvoiceRepository,
    private readonly paymentProvider: PaymentProvider,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(): Promise<ReconcilePendingPaymentsResult> {
    const now = this.clock.now();
    const reconcileThreshold = new Date(now.getTime() - RECONCILE_AFTER_MINUTES * 60_000);
    const expireThreshold = new Date(now.getTime() - EXPIRE_AFTER_MINUTES * 60_000);

    const candidates = await this.paymentRepository.listPendingInitiatedBefore(reconcileThreshold);

    let confirmedSucceeded = 0;
    let confirmedFailed = 0;
    let expired = 0;

    for (const candidate of candidates) {
      const providerStatus = await this.paymentProvider.reconcileTransaction(candidate.providerTransactionId);

      await this.unitOfWork.withTransaction(
        async () => {
          const payment = await this.paymentRepository.findById(candidate.id, candidate.tenantId);
          if (payment === null) {
            return;
          }

          let apply: (current: Payment) => void;

          if (providerStatus === 'SUCCEEDED') {
            const invoice = await this.platformInvoiceRepository.findById(payment.platformInvoiceId, payment.tenantId);
            if (invoice === null) {
              throw new Error(
                `PlatformInvoice ${payment.platformInvoiceId.toString()} introuvable pour le Payment ${payment.id.toString()} (etat incoherent).`,
              );
            }
            apply = (current) =>
              current.confirmSucceeded({
                providerTransactionId: current.providerTransactionId,
                confirmedAt: now,
                newPeriodStartsAt: invoice.periodStartsAt,
                newPeriodEndsAt: invoice.periodEndsAt,
                // Meme discipline que ConfirmPayment.ts : la reference opaque vient de la facture
                // deja chargee, jamais recalculee (voir PlatformInvoice.ts).
                sourceReference: invoice.sourceReference,
                clock: this.clock,
                idGenerator: this.idGenerator,
              });
            confirmedSucceeded += 1;
          } else if (providerStatus === 'FAILED') {
            apply = (current) => current.confirmFailed({ providerTransactionId: current.providerTransactionId });
            confirmedFailed += 1;
          } else if (payment.initiatedAt.getTime() <= expireThreshold.getTime()) {
            // `PENDING` ou `NOT_FOUND` cote prestataire, ET trop ancien : abandon (EXPIRED).
            apply = (current) => current.markExpired();
            expired += 1;
          } else {
            return;
          }

          await this.saveWithConcurrencyRetry(payment, apply);
        },
        { tenantId: candidate.tenantId },
      );
    }

    return { reconciled: candidates.length, confirmedSucceeded, confirmedFailed, expired };
  }

  /**
   * Meme pattern que `ConfirmPaymentHandler.saveWithConcurrencyRetry` (voir ConfirmPayment.ts) —
   * duplique volontairement plutot que factorise dans un helper partage : deux occurrences d'une
   * boucle de retry de trois lignes ne justifient pas une abstraction transversale au module,
   * surtout que les deux versions restent libres de diverger si un des deux writers a besoin d'une
   * politique de retry differente plus tard. Applique `apply` (commande de domaine IDEMPOTENTE) sur
   * `payment`, sauvegarde, et RETENTE en cas de `PaymentConcurrencyConflictError` en relisant
   * l'agregat FRAIS et en reappliquant la meme commande dessus, jusqu'a `MAX_SAVE_ATTEMPTS`
   * tentatives.
   */
  private async saveWithConcurrencyRetry(payment: Payment, apply: (payment: Payment) => void): Promise<void> {
    let current = payment;
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
      apply(current);
      try {
        await this.paymentRepository.save(current, current.tenantId);
        return;
      } catch (error) {
        if (!(error instanceof PaymentConcurrencyConflictError) || attempt === MAX_SAVE_ATTEMPTS) {
          throw error;
        }
        const reloaded = await this.paymentRepository.findById(current.id, current.tenantId);
        if (reloaded === null) {
          // Ne devrait pas arriver : `current` existait a l'instant precedent (le conflit vient
          // d'un UPDATE concurrent, pas d'une suppression — Payment n'est jamais supprime) —
          // remonte l'erreur d'origine plutot que de masquer une incoherence.
          throw error;
        }
        current = reloaded;
      }
    }
  }
}
