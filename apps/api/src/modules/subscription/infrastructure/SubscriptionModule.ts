import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventHandler } from '../../../shared-kernel/application/OutboxEventHandler.js';
import { PgUnitOfWork } from '../../../shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { StartTrialSubscriptionHandler } from '../application/commands/StartTrialSubscription.js';
import { UpgradeSubscriptionPlanHandler } from '../application/commands/UpgradeSubscriptionPlan.js';
import { CheckUsersQuotaHandler } from '../application/services/CheckUsersQuota.js';
import { ProcessSubscriptionRenewalsHandler } from '../application/services/ProcessSubscriptionRenewals.js';
import { createReactivateSubscriptionOnPaymentSucceededHandler } from '../application/services/ReactivateSubscriptionOnPaymentSucceeded.js';
import type { PlanChangeRepository } from '../domain/ports/PlanChangeRepository.js';
import type { PlanPriceRepository } from '../domain/ports/PlanPriceRepository.js';
import type { PlanRepository } from '../domain/ports/PlanRepository.js';
import type { SubscriptionRepository } from '../domain/ports/SubscriptionRepository.js';
import { PrismaPlanChangeRepository } from './persistence/PrismaPlanChangeRepository.js';
import { PrismaPlanPriceRepository } from './persistence/PrismaPlanPriceRepository.js';
import { PrismaPlanRepository } from './persistence/PrismaPlanRepository.js';
import { PrismaSubscriptionRepository } from './persistence/PrismaSubscriptionRepository.js';
import { seedPlanCatalog } from './seed/seedSubscriptionCatalog.js';

export interface SubscriptionModule {
  readonly repositories: {
    readonly plans: PlanRepository;
    readonly planPrices: PlanPriceRepository;
    readonly subscriptions: SubscriptionRepository;
    readonly planChanges: PlanChangeRepository;
  };
  readonly unitOfWork: UnitOfWork;
  readonly handlers: {
    readonly startTrialSubscription: StartTrialSubscriptionHandler;
    readonly upgradeSubscriptionPlan: UpgradeSubscriptionPlanHandler;
  };
  readonly services: {
    readonly checkUsersQuota: CheckUsersQuotaHandler;
    /** Scheduler applicatif O-25.6 (grace/degrade) — invoque periodiquement, voir infrastructure/scheduler/SubscriptionRenewalScheduler.ts. */
    readonly processSubscriptionRenewals: ProcessSubscriptionRenewalsHandler;
  };
  /** Consommateurs Outbox exposes par ce module — cables UNIQUEMENT dans composition-root.ts. */
  readonly outboxHandlers: {
    readonly reactivateSubscriptionOnPaymentSucceeded: OutboxEventHandler;
  };
}

/**
 * Cablage du module Subscription (Phase 0, etape 4/13).
 *
 * Instancie son propre `PgUnitOfWork` plutot que de recevoir celui de Tenant/Identity en
 * dependance — meme raisonnement que `TenantModule.ts` : `PgUnitOfWork` est un adaptateur sans
 * etat propre au-dela de la reference au `PrismaClient` partage, deux instances qui l'enveloppent
 * sont strictement equivalentes. Ce module ne depend d'aucun autre module (ni Identity ni
 * Tenant) : voir le residu documente en fin de tache sur l'absence volontaire d'un port
 * `TenantAccessChecker` a ce stade.
 */
export function buildSubscriptionModule(deps: {
  prisma: PrismaClient;
  clock: Clock;
  idGenerator: IdGenerator;
}): SubscriptionModule {
  const plans = new PrismaPlanRepository(deps.prisma);
  const planPrices = new PrismaPlanPriceRepository(deps.prisma);
  const subscriptions = new PrismaSubscriptionRepository(deps.prisma);
  const planChanges = new PrismaPlanChangeRepository(deps.prisma);
  const unitOfWork = new PgUnitOfWork(deps.prisma);

  return {
    repositories: { plans, planPrices, subscriptions, planChanges },
    unitOfWork,
    handlers: {
      startTrialSubscription: new StartTrialSubscriptionHandler(
        plans,
        planPrices,
        subscriptions,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
      upgradeSubscriptionPlan: new UpgradeSubscriptionPlanHandler(
        plans,
        planPrices,
        subscriptions,
        planChanges,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
    },
    services: {
      checkUsersQuota: new CheckUsersQuotaHandler(subscriptions, plans),
      processSubscriptionRenewals: new ProcessSubscriptionRenewalsHandler(
        subscriptions,
        planPrices,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
    },
    outboxHandlers: {
      reactivateSubscriptionOnPaymentSucceeded: createReactivateSubscriptionOnPaymentSucceededHandler({
        subscriptionRepository: subscriptions,
        unitOfWork,
        clock: deps.clock,
        idGenerator: deps.idGenerator,
      }),
    },
  };
}

/** Reexporte pour les points d'amorçage (tests d'integration, futur script de seed applicatif). */
export { seedPlanCatalog };
