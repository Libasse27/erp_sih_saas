import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { Payment } from '../../domain/Payment.js';
import { PaymentConcurrencyConflictError, type PaymentRepository } from '../../domain/ports/PaymentRepository.js';
import type { PlatformInvoiceRepository } from '../../domain/ports/PlatformInvoiceRepository.js';
import type { PaymentProvider } from '../../domain/ports/PaymentProvider.js';
import { isTerminalSuccessStatus } from '../../domain/value-objects/PaymentStatus.js';
import type { BillingAuditTrail } from '../ports/BillingAuditTrail.js';

export type ConfirmPaymentError = 'INVALID_SIGNATURE' | 'INVALID_PAYLOAD' | 'UNKNOWN_TRANSACTION' | 'AMOUNT_MISMATCH';

/**
 * Nombre d'essais de `save()` avant d'abandonner face a des conflits de verrouillage optimiste
 * repetes (voir `saveWithConcurrencyRetry` plus bas) — un echec PERSISTANT au-dela de ce nombre
 * est un signal d'anomalie reelle (contention anormalement elevee sur un MEME Payment), pas
 * une race benigne attendue : propager l'erreur plutot que de boucler indefiniment.
 */
const MAX_SAVE_ATTEMPTS = 3;

export interface ConfirmPaymentCommand {
  readonly rawBody: string;
  readonly signatureHeader: string | undefined;
}

export interface ConfirmPaymentResult {
  readonly status: 'PROCESSED';
}

export interface ConfirmPaymentLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * Point d'entree UNIQUE de confirmation de paiement serveur-a-serveur (O-25.5 : "confirmation
 * exclusivement serveur-a-serveur... jamais d'activation sur retour frontend"). Aucune autre
 * commande de ce module ne permet de faire passer un `Payment` en succes — c'est ce qui rend
 * "une tentative d'activation depuis un flux frontend sans confirmation fournisseur" IMPOSSIBLE
 * PAR CONSTRUCTION (pas seulement refusee par une regle) : il n'existe simplement aucun chemin de
 * code qui accepte un statut de succes fourni par le client.
 *
 * Ordre des verifications = ordre des exigences O-25.5, dans le meme ordre :
 *   1. Signature obligatoire, rejet SILENCIEUX si absente/invalide (`INVALID_SIGNATURE` —
 *      volontairement peu informatif : le controleur HTTP doit repondre de maniere identique,
 *      quelle que soit la raison exacte du rejet, pour ne jamais confirmer a un tiers qu'un
 *      `providerTransactionId` existe ou non).
 *   2. Payload illisible -> `INVALID_PAYLOAD`, meme discipline de non-fuite.
 *   3. `providerTransactionId` inconnu -> `UNKNOWN_TRANSACTION`, idem (webhook rejoue, mal
 *      route, ou attaque par sondage — la reponse HTTP ne doit jamais permettre de distinguer ce
 *      cas d'une signature invalide, voir presentation/http/PaymentWebhookController.ts).
 *   4. Pour un `outcome === 'SUCCEEDED'` uniquement : le montant rapporte par le webhook
 *      (`webhookEvent.amount`) doit correspondre exactement au montant du `Payment` retrouve ->
 *      sinon `AMOUNT_MISMATCH`, defense en profondeur (le webhook n'est deja pas la seule source
 *      de verite, O-25.5, mais rien ne verifiait jusqu'ici qu'il porte sur le BON montant). Aucun
 *      equivalent sur `outcome === 'FAILED'` : un echec ne transporte aucune somme a rapprocher.
 *      Ce controle est ABSENT du rapprochement periodique (`ReconcilePendingPayments.ts`) —
 *      residu documente explicitement la-bas : `ProviderTransactionStatus` ne porte aucun
 *      montant, le contrat de `reconcileTransaction()` ne le permet pas a cette etape.
 *
 * Idempotence ENTIEREMENT deleguee a `Payment.confirmSucceeded()`/`confirmFailed()` (voir
 * Payment.ts) : ce handler ne fait aucune verification d'idempotence lui-meme, il applique
 * simplement l'evenement recu sur l'agregat retrouve.
 */
export class ConfirmPaymentHandler {
  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly platformInvoiceRepository: PlatformInvoiceRepository,
    private readonly paymentProvider: PaymentProvider,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly billingAuditTrail: BillingAuditTrail,
    private readonly logger?: ConfirmPaymentLogger,
  ) {}

  async execute(command: ConfirmPaymentCommand): Promise<Result<ConfirmPaymentResult, ConfirmPaymentError>> {
    const signatureValid = this.paymentProvider.verifyWebhookSignature({
      rawBody: command.rawBody,
      signatureHeader: command.signatureHeader,
    });
    if (!signatureValid) {
      this.logger?.warn(
        { event: 'payment.webhook.rejected', reason: 'invalid_signature' },
        'Webhook paiement rejete (signature absente ou invalide)',
      );
      return Result.failure('INVALID_SIGNATURE');
    }

    const webhookEvent = this.paymentProvider.parseWebhookPayload(command.rawBody);
    if (webhookEvent === null) {
      this.logger?.warn(
        { event: 'payment.webhook.rejected', reason: 'invalid_payload' },
        'Webhook paiement rejete (payload illisible)',
      );
      return Result.failure('INVALID_PAYLOAD');
    }

    // Pas de `{ tenantId }` passe a `withTransaction` : le tenant n'est connu QU'APRES avoir
    // retrouve le Payment par `providerTransactionId` (voir PaymentRepository.
    // findByProviderTransactionId) — impossible de le positionner en `SET LOCAL app.tenant_id`
    // AVANT la requete qui le determine. Sans consequence : `platform.Payment`/
    // `platform.PlatformInvoice` sont de toute facon HORS RLS (ADR-0001 §3.3), seule barriere
    // reelle = le filtrage applicatif explicite deja en place dans les repositories.
    return this.unitOfWork.withTransaction(async () => {
      const payment = await this.paymentRepository.findByProviderTransactionId(webhookEvent.providerTransactionId);
      if (payment === null) {
        this.logger?.warn(
          { event: 'payment.webhook.rejected', reason: 'unknown_transaction' },
          'Webhook paiement rejete (transaction inconnue)',
        );
        return Result.failure('UNKNOWN_TRANSACTION');
      }

      if (webhookEvent.outcome === 'FAILED') {
        // Idempotence PAR CONSTRUCTION (`confirmFailed()` est un no-op sur un succes/annulation
        // terminal, voir Payment.ts) : capture AVANT mutation, comme pour le succes ci-dessous —
        // jamais de seconde entree d'audit sur un rejeu webhook.
        const alreadyTerminal = isTerminalSuccessStatus(payment.status) || payment.status === 'CANCELLED';
        await this.saveWithConcurrencyRetry(payment, (current) =>
          current.confirmFailed({ providerTransactionId: webhookEvent.providerTransactionId }),
        );
        if (!alreadyTerminal) {
          await this.billingAuditTrail.record({
            eventType: 'BILLING_PAYMENT_CONFIRMED',
            outcome: 'FAILURE',
            tenantId: payment.tenantId.toString(),
            actorKind: 'SYSTEM',
            actorUserId: null,
            targetType: 'PAYMENT',
            targetId: payment.id.toString(),
            reason: null,
            sessionId: null,
            correlationId: null,
          });
        }
        return Result.success({ status: 'PROCESSED' });
      }

      // Defense en profondeur (O-25.5 traite deja le webhook comme non totalement fiable) : un
      // webhook SUCCEEDED qui porte le bon `providerTransactionId` mais un montant different de
      // celui du Payment retrouve n'est PAS applique — rejet AVANT tout appel a
      // `confirmSucceeded()`, aucun effet de bord. Pas de verification equivalente cote
      // `ReconcilePendingPayments.ts` : voir residu documente en tete de fichier.
      if (!webhookEvent.amount.equals(payment.amount)) {
        this.logger?.warn(
          {
            event: 'payment.webhook.rejected',
            reason: 'amount_mismatch',
            expectedAmount: payment.amount.amount,
            webhookAmount: webhookEvent.amount.amount,
          },
          'Webhook paiement rejete (montant incoherent avec le Payment)',
        );
        return Result.failure('AMOUNT_MISMATCH');
      }

      const invoice = await this.platformInvoiceRepository.findById(payment.platformInvoiceId, payment.tenantId);
      if (invoice === null) {
        throw new Error(
          `PlatformInvoice ${payment.platformInvoiceId.toString()} introuvable pour le Payment ${payment.id.toString()} (etat incoherent).`,
        );
      }

      const alreadySucceeded = isTerminalSuccessStatus(payment.status);
      await this.saveWithConcurrencyRetry(payment, (current) =>
        current.confirmSucceeded({
          providerTransactionId: webhookEvent.providerTransactionId,
          confirmedAt: webhookEvent.occurredAt,
          newPeriodStartsAt: invoice.periodStartsAt,
          newPeriodEndsAt: invoice.periodEndsAt,
          // Restitue telle quelle la reference opaque portee par la facture (voir
          // PlatformInvoice.ts) : c'est elle qui permettra au module emetteur de retrouver SON
          // fait metier a l'origine du paiement. Jamais reconstruite ni devinee ici.
          sourceReference: invoice.sourceReference,
          clock: this.clock,
          idGenerator: this.idGenerator,
        }),
      );
      if (!alreadySucceeded) {
        await this.billingAuditTrail.record({
          eventType: 'BILLING_PAYMENT_CONFIRMED',
          outcome: 'SUCCESS',
          tenantId: payment.tenantId.toString(),
          actorKind: 'SYSTEM',
          actorUserId: null,
          targetType: 'PAYMENT',
          targetId: payment.id.toString(),
          reason: null,
          sessionId: null,
          correlationId: null,
        });
      }
      return Result.success({ status: 'PROCESSED' });
    });
  }

  /**
   * Applique `apply` (une commande de domaine IDEMPOTENTE — `confirmFailed`/`confirmSucceeded`,
   * voir Payment.ts) sur `payment`, sauvegarde, et RETENTE en cas de
   * `PaymentConcurrencyConflictError` (voir domain/ports/PaymentRepository.ts) : cette erreur
   * signale qu'un AUTRE writer (typiquement `ReconcilePendingPaymentsHandler`, voir le residu
   * documente la-bas sur la race webhook/rapprochement) a ecrit ce MEME Payment entre notre
   * lecture et notre ecriture. On relit l'agregat FRAIS depuis le repository, on reapplique LA
   * MEME commande dessus (no-op si l'etat lu est deja terminal, par construction de Payment), puis
   * on re-sauvegarde — jusqu'a `MAX_SAVE_ATTEMPTS` tentatives. Un echec persistant au-dela est
   * propage (jamais avale) : signal d'anomalie reelle.
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
