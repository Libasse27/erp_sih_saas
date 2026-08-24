import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { Subscription } from '../../domain/Subscription.js';
import type { PlanPriceRepository } from '../../domain/ports/PlanPriceRepository.js';
import type { PlanRepository } from '../../domain/ports/PlanRepository.js';
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository.js';

export interface StartTrialSubscriptionCommand {
  readonly tenantId: string;
}

export type StartTrialSubscriptionError =
  | 'INVALID_TENANT_ID'
  | 'SUBSCRIPTION_ALREADY_EXISTS'
  | 'STANDARD_PLAN_NOT_FOUND'
  | 'STANDARD_PLAN_PRICE_NOT_FOUND';

export interface StartTrialSubscriptionResult {
  readonly subscriptionId: string;
  readonly trialEndsAt: string;
}

/**
 * Demarre l'essai gratuit d'un tenant (O-02.5) : forfait STANDARD, 30 jours, sans moyen de
 * paiement requis. Ne couvre QUE la creation de l'agregat `Subscription` — cette commande
 * suppose que le tenant existe deja (module Tenant, etape 3) ; elle ne verifie PAS son existence
 * via `TenantAccessChecker` (pas de port cross-module ajoute ici, hors perimetre de cette etape
 * — voir rapport de fin de tache) : appeler cette commande pour un tenant inexistant produit un
 * abonnement orphelin, la responsabilite de ne pas le faire revient a l'orchestrateur appelant
 * (Saga de provisioning complete, etape 10, hors perimetre).
 *
 * Le forfait STANDARD et son tarif MENSUEL effectif sont resolus depuis le catalogue seed
 * (`infrastructure/seed/seedSubscriptionCatalog.ts`) — jamais codes en dur ici.
 */
export class StartTrialSubscriptionHandler {
  constructor(
    private readonly planRepository: PlanRepository,
    private readonly planPriceRepository: PlanPriceRepository,
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(
    command: StartTrialSubscriptionCommand,
  ): Promise<Result<StartTrialSubscriptionResult, StartTrialSubscriptionError>> {
    const tenantIdResult = TenantId.create(command.tenantId);
    if (tenantIdResult.isFailure()) {
      return Result.failure('INVALID_TENANT_ID');
    }
    const tenantId = tenantIdResult.getValue();

    return this.unitOfWork.withTransaction(
      async () => {
        const existing = await this.subscriptionRepository.findByTenantId(tenantId);
        if (existing !== null) {
          return Result.failure('SUBSCRIPTION_ALREADY_EXISTS');
        }

        const standardPlan = await this.planRepository.findByCode('STANDARD');
        if (standardPlan === null) {
          return Result.failure('STANDARD_PLAN_NOT_FOUND');
        }

        const now = this.clock.now();
        const standardPrice = await this.planPriceRepository.findEffectivePrice(standardPlan.id, 'MENSUEL', now);
        if (standardPrice === null) {
          return Result.failure('STANDARD_PLAN_PRICE_NOT_FOUND');
        }

        const subscription = Subscription.startTrial({
          tenantId,
          standardPlanId: standardPlan.id,
          standardPlanPriceId: standardPrice.id,
          clock: this.clock,
          idGenerator: this.idGenerator,
        });

        await this.subscriptionRepository.save(subscription, tenantId);

        const trialEndsAt = subscription.trialEndsAt;
        if (trialEndsAt === null) {
          // Invariant viole : Subscription.startTrial() renseigne TOUJOURS trialEndsAt — voir
          // Subscription.ts. Une valeur nulle ici serait un bug, pas un echec metier attendu.
          throw new Error("Invariant viole : un abonnement demarre par startTrial() doit avoir trialEndsAt renseigne.");
        }

        return Result.success({
          subscriptionId: subscription.id.toString(),
          trialEndsAt: trialEndsAt.toISOString(),
        });
      },
      { tenantId },
    );
  }
}
