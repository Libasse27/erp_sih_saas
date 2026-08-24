import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlanChange } from '../../domain/PlanChange.js';
import { calculateUpgradeProration } from '../../domain/services/ProrationCalculator.js';
import { isPlanCode } from '../../domain/value-objects/PlanCode.js';
import type { PlanChangeRepository } from '../../domain/ports/PlanChangeRepository.js';
import type { PlanPriceRepository } from '../../domain/ports/PlanPriceRepository.js';
import type { PlanRepository } from '../../domain/ports/PlanRepository.js';
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository.js';

export interface UpgradeSubscriptionPlanCommand {
  readonly tenantId: string;
  readonly targetPlanCode: string;
}

export type UpgradeSubscriptionPlanError =
  | 'INVALID_TENANT_ID'
  | 'INVALID_PLAN_CODE'
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'TARGET_PLAN_NOT_FOUND'
  | 'TARGET_PLAN_PRICE_NOT_FOUND'
  | 'CURRENT_PLAN_PRICE_NOT_FOUND'
  | 'NOT_AN_UPGRADE';

export interface UpgradeSubscriptionPlanResult {
  readonly planChangeId: string;
  readonly newPlanPriceId: string;
  readonly proratedAmountXof: number;
}

/**
 * Change immediatement le forfait d'un abonnement vers un forfait de prix strictement superieur
 * (upgrade proratise, O-02.6). Le downgrade (differe a la fin de periode, jamais proratise) est
 * explicitement HORS PERIMETRE de cette commande — un downgrade doit passer par un flux distinct
 * (non implemente a cette etape), jamais par celle-ci avec un code d'erreur `NOT_AN_UPGRADE`
 * traite comme un cas degrade.
 *
 * Resout TOUJOURS le tarif ACTUELLEMENT applique via `subscription.currentPlanPriceId` (jamais
 * `subscription.plan.price`) et le tarif effectif du forfait cible via `PlanPriceRepository`
 * (jamais depuis `Plan` directement) — contrainte O-02.6. C'est ce qui garantit, SANS logique
 * additionnelle ici, que plusieurs upgrades successifs dans la meme periode se calculent chacun
 * depuis le forfait actuellement actif : `subscription.currentPlanPriceId` a deja ete mis a jour
 * par l'upgrade precedent avant que celui-ci ne s'execute.
 */
export class UpgradeSubscriptionPlanHandler {
  constructor(
    private readonly planRepository: PlanRepository,
    private readonly planPriceRepository: PlanPriceRepository,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly planChangeRepository: PlanChangeRepository,
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

    return this.unitOfWork.withTransaction(
      async () => {
        const subscription = await this.subscriptionRepository.findByTenantId(tenantId);
        if (subscription === null) {
          return Result.failure('SUBSCRIPTION_NOT_FOUND');
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

        const fromPlanId = subscription.planId;
        const fromPlanPriceId = subscription.currentPlanPriceId;

        subscription.changePlan({
          newPlanId: targetPlan.id,
          newPlanPriceId: targetPrice.id,
          clock: this.clock,
          idGenerator: this.idGenerator,
        });

        const planChange = PlanChange.create({
          subscriptionId: subscription.id,
          tenantId,
          changeType: 'UPGRADE',
          fromPlanId,
          fromPlanPriceId,
          toPlanId: targetPlan.id,
          toPlanPriceId: targetPrice.id,
          proratedAmount,
          clock: this.clock,
          idGenerator: this.idGenerator,
        });

        await this.subscriptionRepository.save(subscription, tenantId);
        await this.planChangeRepository.append(planChange, tenantId);

        return Result.success({
          planChangeId: planChange.id.toString(),
          newPlanPriceId: targetPrice.id.toString(),
          proratedAmountXof: proratedAmount.amount,
        });
      },
      { tenantId },
    );
  }
}
