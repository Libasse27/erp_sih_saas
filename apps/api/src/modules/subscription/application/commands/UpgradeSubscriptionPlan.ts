import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { calculateUpgradeProration } from '../../domain/services/ProrationCalculator.js';
import { isPlanCode, type PlanCode } from '../../domain/value-objects/PlanCode.js';
import {
  PlanUpgradeRequestConflictError,
  type PlanUpgradeRequestRepository,
} from '../../domain/ports/PlanUpgradeRequestRepository.js';
import type { PlanPriceRepository } from '../../domain/ports/PlanPriceRepository.js';
import type { PlanRepository } from '../../domain/ports/PlanRepository.js';
import {
  SubscriptionConcurrencyConflictError,
  type SubscriptionRepository,
} from '../../domain/ports/SubscriptionRepository.js';

export interface UpgradeSubscriptionPlanCommand {
  readonly tenantId: string;
  readonly targetPlanCode: string;
}

export type UpgradeSubscriptionPlanError =
  | 'INVALID_TENANT_ID'
  | 'INVALID_PLAN_CODE'
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'SUBSCRIPTION_NOT_UPGRADABLE'
  | 'TARGET_PLAN_NOT_FOUND'
  | 'TARGET_PLAN_PRICE_NOT_FOUND'
  | 'CURRENT_PLAN_PRICE_NOT_FOUND'
  | 'NOT_AN_UPGRADE'
  | 'UPGRADE_ALREADY_PENDING';

export interface UpgradeSubscriptionPlanResult {
  readonly planChangeId: string;
  readonly proratedAmountXof: number;
  readonly status: 'PENDING_PAYMENT';
  /** ISO 8601 UTC — instant au-dela duquel la demande est consideree abandonnee (TTL, voir Subscription.UPGRADE_REQUEST_TTL_HOURS). */
  readonly expiresAt: string;
}

/**
 * Un conflit de verrouillage optimiste est ICI un evenement rare : cette commande est le premier
 * writer d'un abonnement qu'elle vient tout juste de lire, et elle n'entre en concurrence qu'avec
 * le scheduler de renouvellement ou une confirmation de paiement tombant exactement dans cette
 * fenetre. Une SEULE nouvelle tentative suffit donc (contrairement aux trois de
 * `ApplyPlanUpgradeOnPaymentSucceeded`, ou la contention est structurelle) ; au-dela, l'erreur est
 * propagee plutot que masquee par des reessais indefinis.
 */
const MAX_ATTEMPTS = 2;

/**
 * DEMANDE un upgrade proratise vers un forfait de prix strictement superieur (O-02.6) — et ne
 * l'applique PAS. C'est le changement central de la passe 2 : jusqu'ici cette commande changeait le
 * forfait IMMEDIATEMENT et GRATUITEMENT (aucune facture, aucun paiement). Desormais elle produit
 * une intention payante :
 *
 *   demande -> prorata calcule -> PlanUpgradeRequest + `SubscriptionUpgradeRequested`
 *           -> (module payment) PlatformInvoice -> Payment -> confirmation serveur
 *           -> (retour ici) ApplyPlanUpgradeOnPaymentSucceeded -> forfait effectivement change
 *
 * En cas d'echec ou d'expiration du paiement, l'ancien forfait reste actif : il n'existe aucun etat
 * intermediaire ou le tenant beneficierait de capacites non payees.
 *
 * Cette commande N'APPELLE JAMAIS `Subscription.applyPlanUpgrade()` ni ne cree de `PlanChange` :
 * ces deux ecritures appartiennent exclusivement au consommateur Outbox
 * `ApplyPlanUpgradeOnPaymentSucceeded.ts`. C'est ce qui rend "monter en gamme sans payer"
 * impossible PAR CONSTRUCTION, et non simplement refuse par une regle.
 *
 * Resout TOUJOURS le tarif ACTUELLEMENT applique via `subscription.currentPlanPriceId` (jamais
 * `subscription.plan.price`) et le tarif effectif du forfait cible via `PlanPriceRepository`
 * (jamais depuis `Plan` directement) — contrainte O-02.6, inchangee.
 *
 * NOTE sur les upgrades successifs : la contrainte UNIQUE `subscription_id` de
 * `SubscriptionPlanUpgradeRequest` limite a UNE demande en attente par abonnement. Un second
 * upgrade n'est donc possible qu'une fois le premier paye (la demande est alors supprimee) ou
 * expire (elle est alors remplacee) — le prorata du second partira du forfait REELLEMENT actif a ce
 * moment-la, jamais d'un forfait simplement demande.
 */
export class UpgradeSubscriptionPlanHandler {
  constructor(
    private readonly planRepository: PlanRepository,
    private readonly planPriceRepository: PlanPriceRepository,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly planUpgradeRequestRepository: PlanUpgradeRequestRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(
    command: UpgradeSubscriptionPlanCommand,
  ): Promise<Result<UpgradeSubscriptionPlanResult, UpgradeSubscriptionPlanError>> {
    const tenantIdResult = TenantId.create(command.tenantId);
    if (tenantIdResult.isFailure()) {
      return Result.failure('INVALID_TENANT_ID');
    }
    const tenantId = tenantIdResult.getValue();

    if (!isPlanCode(command.targetPlanCode)) {
      return Result.failure('INVALID_PLAN_CODE');
    }
    const targetPlanCode = command.targetPlanCode;

    // Le retry entoure la TRANSACTION ENTIERE, jamais seulement le `save()` : un conflit optimiste
    // doit annuler AUSSI l'insertion de la `PlanUpgradeRequest` faite dans la meme transaction,
    // sinon la nouvelle tentative se heurterait a sa propre ligne. On repart donc d'un etat propre
    // (nouvel identifiant compris), plutot que de rejouer un fragment de travail deja partiellement
    // ecrit.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.attempt(tenantId, targetPlanCode);
      } catch (error) {
        if (!(error instanceof SubscriptionConcurrencyConflictError) || attempt === MAX_ATTEMPTS) {
          throw error;
        }
      }
    }

    // Inatteignable : la boucle ci-dessus retourne ou propage a la derniere tentative. Presente
    // uniquement pour satisfaire l'analyse de flot du compilateur.
    throw new Error('UpgradeSubscriptionPlanHandler : sortie de boucle de tentatives inattendue.');
  }

  private async attempt(
    tenantId: TenantId,
    targetPlanCode: PlanCode,
  ): Promise<Result<UpgradeSubscriptionPlanResult, UpgradeSubscriptionPlanError>> {
    return this.unitOfWork.withTransaction(
      async () => {
        const subscription = await this.subscriptionRepository.findByTenantId(tenantId);
        if (subscription === null) {
          return Result.failure('SUBSCRIPTION_NOT_FOUND');
        }

        // Decision produit : un upgrade proratise n'est ouvert QU'A un abonnement ACTIVE. Un code
        // d'erreur UNIQUE pour les trois autres statuts (TRIALING/GRACE_PERIOD/DEGRADED) : les
        // distinguer exposerait l'etat de recouvrement du compte a l'appelant sans qu'aucune de ces
        // situations n'appelle une action differente de sa part (regulariser d'abord).
        if (subscription.status !== 'ACTIVE') {
          return Result.failure('SUBSCRIPTION_NOT_UPGRADABLE');
        }

        const targetPlan = await this.planRepository.findByCode(targetPlanCode);
        if (targetPlan === null) {
          return Result.failure('TARGET_PLAN_NOT_FOUND');
        }

        const now = this.clock.now();
        const targetPrice = await this.planPriceRepository.findEffectivePrice(
          targetPlan.id,
          subscription.period,
          now,
        );
        if (targetPrice === null) {
          return Result.failure('TARGET_PLAN_PRICE_NOT_FOUND');
        }

        const currentPrice = await this.planPriceRepository.findById(subscription.currentPlanPriceId);
        if (currentPrice === null) {
          return Result.failure('CURRENT_PLAN_PRICE_NOT_FOUND');
        }

        const prorationResult = calculateUpgradeProration({
          oldPrice: currentPrice.amount,
          newPrice: targetPrice.amount,
          periodStartsAt: subscription.periodStartsAt,
          periodEndsAt: subscription.periodEndsAt,
          now,
        });
        if (prorationResult.isFailure()) {
          return Result.failure(prorationResult.getError());
        }
        const proratedAmount = prorationResult.getValue();

        // Identifiant MINTE ICI, a la demande : il sert d'identite a la `PlanUpgradeRequest`, de
        // reference opaque (`sourceReference`) portee par la facture puis restituee par
        // `SaaSPaymentSucceeded`, et enfin d'identifiant de la ligne d'historique `PlanChange`
        // ecrite a l'application. Un seul identifiant pour tout le cycle de vie du fait metier.
        const planChangeId = this.idGenerator.generate();

        const request = subscription.requestUpgrade({
          planChangeId,
          toPlanId: targetPlan.id,
          toPlanPriceId: targetPrice.id,
          proratedAmount,
          now,
          clock: this.clock,
          idGenerator: this.idGenerator,
        });

        try {
          await this.planUpgradeRequestRepository.replaceExpiredAndInsert(request, tenantId, now);
        } catch (error) {
          if (error instanceof PlanUpgradeRequestConflictError) {
            // Une demande NON expiree existe deja pour cet abonnement : double-clic, double
            // soumission, ou seconde requete concurrente ayant gagne la course. Refus explicite
            // plutot qu'une seconde facture pour le meme upgrade.
            return Result.failure('UPGRADE_ALREADY_PENDING');
          }
          throw error;
        }

        // Ecrit `SubscriptionUpgradeRequested` dans l'Outbox, DANS CETTE MEME TRANSACTION que la
        // demande ci-dessus (D9) : la facture ne peut donc jamais etre emise pour une demande qui
        // n'aurait pas ete persistee, ni l'inverse.
        await this.subscriptionRepository.save(subscription, tenantId);

        return Result.success({
          planChangeId,
          proratedAmountXof: proratedAmount.amount,
          status: 'PENDING_PAYMENT' as const,
          expiresAt: request.expiresAt.toISOString(),
        });
      },
      { tenantId },
    );
  }
}
