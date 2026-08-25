import type { Clock } from '../../../src/shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../src/shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork, UnitOfWorkContext } from '../../../src/shared-kernel/application/UnitOfWork.js';
import type { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Result } from '../../../src/shared-kernel/domain/Result.js';
import type { Plan } from '../../../src/modules/subscription/domain/Plan.js';
import type { PlanRepository } from '../../../src/modules/subscription/domain/ports/PlanRepository.js';
import type { PlanCode } from '../../../src/modules/subscription/domain/value-objects/PlanCode.js';
import type { PlanId } from '../../../src/modules/subscription/domain/value-objects/PlanId.js';
import type { PlanPrice } from '../../../src/modules/subscription/domain/PlanPrice.js';
import type { PlanPriceRepository } from '../../../src/modules/subscription/domain/ports/PlanPriceRepository.js';
import type { BillingPeriod } from '../../../src/modules/subscription/domain/value-objects/BillingPeriod.js';
import type { PlanPriceId } from '../../../src/modules/subscription/domain/value-objects/PlanPriceId.js';
import type { Subscription } from '../../../src/modules/subscription/domain/Subscription.js';
import type { SubscriptionRepository } from '../../../src/modules/subscription/domain/ports/SubscriptionRepository.js';
import type { SubscriptionId } from '../../../src/modules/subscription/domain/value-objects/SubscriptionId.js';
import type { PlanChange } from '../../../src/modules/subscription/domain/PlanChange.js';
import type { PlanChangeRepository } from '../../../src/modules/subscription/domain/ports/PlanChangeRepository.js';

// Duplique volontairement les primitives generiques de test/tenant/builders/testKit.ts et
// test/identity/builders/testKit.ts plutot que de les importer d'un autre Bounded Context de
// test : chaque module garde sa suite de test independante (§9.2 du system prompt — "aucune
// base partagee entre fichiers"), y compris pour les doublures de ports partages. Le contenu
// reste strictement identique par construction (memes ports partages du shared-kernel), donc
// aucune divergence de comportement n'est possible.

export class FixedClock implements Clock {
  private current: Date;

  constructor(iso: string) {
    this.current = new Date(iso);
  }

  now(): Date {
    return this.current;
  }

  /** Ajoute a l'etape 5 (scenarios de scheduler sur plusieurs cycles, O-25.6) — inexistant a l'etape 4, aucun test existant n'en dependait. */
  advanceTo(iso: string): void {
    this.current = new Date(iso);
  }
}

/** Genere des UUID v4 valides et deterministes (sequentiels) — jamais Math.random() dans les tests. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  generate(): string {
    this.counter += 1;
    const hex = this.counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  }
}

export function uuidAt(counter: number): string {
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export class InMemoryUnitOfWork implements UnitOfWork {
  public lastContext: UnitOfWorkContext | undefined;

  async withTransaction<T>(work: () => Promise<T>, context?: UnitOfWorkContext): Promise<T> {
    this.lastContext = context;
    return work();
  }
}

export class InMemoryPlanRepository implements PlanRepository {
  private readonly byId = new Map<string, Plan>();

  async findById(id: PlanId): Promise<Plan | null> {
    return this.byId.get(id.toString()) ?? null;
  }

  async findByCode(code: PlanCode): Promise<Plan | null> {
    for (const plan of this.byId.values()) {
      if (plan.code === code) {
        return plan;
      }
    }
    return null;
  }

  async save(plan: Plan): Promise<void> {
    this.byId.set(plan.id.toString(), plan);
  }
}

export class InMemoryPlanPriceRepository implements PlanPriceRepository {
  private readonly byId = new Map<string, PlanPrice>();

  async findById(id: PlanPriceId): Promise<PlanPrice | null> {
    return this.byId.get(id.toString()) ?? null;
  }

  async findEffectivePrice(planId: PlanId, period: BillingPeriod, asOf: Date): Promise<PlanPrice | null> {
    let best: PlanPrice | null = null;
    for (const price of this.byId.values()) {
      if (!price.planId.equals(planId) || price.period !== period) {
        continue;
      }
      if (price.effectiveFrom.getTime() > asOf.getTime()) {
        continue;
      }
      if (best === null || price.effectiveFrom.getTime() > best.effectiveFrom.getTime()) {
        best = price;
      }
    }
    return best;
  }

  async save(price: PlanPrice): Promise<void> {
    this.byId.set(price.id.toString(), price);
  }
}

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private readonly byId = new Map<string, Subscription>();

  async findByTenantId(tenantId: TenantId): Promise<Subscription | null> {
    for (const subscription of this.byId.values()) {
      if (subscription.tenantId.equals(tenantId)) {
        return subscription;
      }
    }
    return null;
  }

  async findById(id: SubscriptionId, tenantId: TenantId): Promise<Subscription | null> {
    const subscription = this.byId.get(id.toString());
    if (subscription === undefined || !subscription.tenantId.equals(tenantId)) {
      return null;
    }
    return subscription;
  }

  async save(subscription: Subscription, tenantId: TenantId): Promise<void> {
    if (!subscription.tenantId.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'un Subscription hors du tenant du contexte courant.");
    }
    subscription.pullDomainEvents();
    this.byId.set(subscription.id.toString(), subscription);
  }

  async listSchedulerCandidates(now: Date): Promise<readonly Subscription[]> {
    return [...this.byId.values()].filter((subscription) => {
      if (
        (subscription.status === 'TRIALING' || subscription.status === 'ACTIVE') &&
        subscription.periodEndsAt.getTime() <= now.getTime()
      ) {
        return true;
      }
      if (subscription.status === 'GRACE_PERIOD') {
        return true;
      }
      return subscription.status === 'DEGRADED' && subscription.degradedModeSustainedNotifiedAt === null;
    });
  }
}

export class InMemoryPlanChangeRepository implements PlanChangeRepository {
  private readonly changes: PlanChange[] = [];

  async append(change: PlanChange, tenantId: TenantId): Promise<void> {
    if (!change.tenantId.equals(tenantId)) {
      throw new Error("Tentative d'ajout d'un PlanChange hors du tenant du contexte courant.");
    }
    this.changes.push(change);
  }

  async listBySubscriptionId(subscriptionId: SubscriptionId, tenantId: TenantId): Promise<readonly PlanChange[]> {
    return this.changes.filter(
      (change) => change.subscriptionId.equals(subscriptionId) && change.tenantId.equals(tenantId),
    );
  }
}

export function mustSucceed<T, E>(result: Result<T, E>): T {
  if (result.isFailure()) {
    throw new Error(`Resultat attendu en succes, obtenu en echec : ${JSON.stringify(result.getError())}`);
  }
  return result.getValue();
}

export function mustFail<T, E>(result: Result<T, E>): E {
  if (result.isSuccess()) {
    throw new Error('Resultat attendu en echec, obtenu en succes.');
  }
  return result.getError();
}
