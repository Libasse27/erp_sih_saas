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
import {
  SubscriptionConcurrencyConflictError,
  type SubscriptionRepository,
} from '../../../src/modules/subscription/domain/ports/SubscriptionRepository.js';
import type { SubscriptionId } from '../../../src/modules/subscription/domain/value-objects/SubscriptionId.js';
import type { PlanChange } from '../../../src/modules/subscription/domain/PlanChange.js';
import type { PlanChangeRepository } from '../../../src/modules/subscription/domain/ports/PlanChangeRepository.js';
import type { PlanUpgradeRequest } from '../../../src/modules/subscription/domain/PlanUpgradeRequest.js';
import type {
  SubscriptionAuditRecordInput,
  SubscriptionAuditTrail,
} from '../../../src/modules/subscription/application/ports/SubscriptionAuditTrail.js';
import {
  PlanUpgradeRequestConflictError,
  type PlanUpgradeRequestRepository,
} from '../../../src/modules/subscription/domain/ports/PlanUpgradeRequestRepository.js';

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

  /**
   * Evenements de domaine "publies" par `save()`, dans l'ordre. Tient le role de l'Outbox reelle
   * (`writeDomainEventsToOutbox`, appelee par le repository Prisma juste apres l'ecriture) : sans
   * cela, `save()` viderait les evenements de l'agregat sans laisser aucune trace observable, et
   * aucun test ne pourrait verifier CE QUI a ete emis.
   */
  public readonly publishedEvents: { eventType: string; payload: Record<string, unknown> }[] = [];

  /**
   * Force le PROCHAIN `save()` a lever `SubscriptionConcurrencyConflictError`, une seule fois —
   * simule un writer concurrent ayant ecrit entre la lecture et l'ecriture, sans avoir a
   * orchestrer une vraie course. Permet de couvrir les boucles de retry des consommateurs Outbox
   * en test unitaire (le comportement REEL du verrouillage optimiste est lui couvert par
   * test/subscription/integration/subscriptionOptimisticLock.test.ts, sur PostgreSQL).
   */
  private failNextSave = false;

  failNextSaveWithConflict(): void {
    this.failNextSave = true;
  }

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
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new SubscriptionConcurrencyConflictError(
        `Conflit de verrouillage optimiste simule sur Subscription ${subscription.id.toString()}.`,
      );
    }
    for (const event of subscription.pullDomainEvents()) {
      this.publishedEvents.push({
        eventType: event.eventType,
        // Meme serialisation que l'Outbox reelle (voir OutboxWriter.toJsonPayload) : le test
        // observe donc exactement ce qu'un consommateur recevrait, pas l'instance de classe.
        payload: JSON.parse(JSON.stringify(event)) as Record<string, unknown>,
      });
    }
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

  /** Reproduit le contrat reel (passe 2) : IDEMPOTENT PAR CLE PRIMAIRE — un `id` deja present est un no-op silencieux, jamais une erreur. */
  async append(change: PlanChange, tenantId: TenantId): Promise<void> {
    if (!change.tenantId.equals(tenantId)) {
      throw new Error("Tentative d'ajout d'un PlanChange hors du tenant du contexte courant.");
    }
    const idStr = change.id.toString();
    if (this.changes.some((existing) => existing.id.toString() === idStr)) {
      return;
    }
    this.changes.push(change);
  }

  async findById(id: string, tenantId: TenantId): Promise<PlanChange | null> {
    return (
      this.changes.find((change) => change.id.toString() === id && change.tenantId.equals(tenantId)) ?? null
    );
  }

  async listBySubscriptionId(subscriptionId: SubscriptionId, tenantId: TenantId): Promise<readonly PlanChange[]> {
    return this.changes.filter(
      (change) => change.subscriptionId.equals(subscriptionId) && change.tenantId.equals(tenantId),
    );
  }
}

export class InMemoryPlanUpgradeRequestRepository implements PlanUpgradeRequestRepository {
  private readonly requests = new Map<string, PlanUpgradeRequest>();

  async findBySubscriptionId(
    subscriptionId: SubscriptionId,
    tenantId: TenantId,
  ): Promise<PlanUpgradeRequest | null> {
    for (const request of this.requests.values()) {
      if (request.subscriptionId.equals(subscriptionId) && request.tenantId.equals(tenantId)) {
        return request;
      }
    }
    return null;
  }

  async findById(id: string, tenantId: TenantId): Promise<PlanUpgradeRequest | null> {
    const request = this.requests.get(id);
    if (request === undefined || !request.tenantId.equals(tenantId)) {
      return null;
    }
    return request;
  }

  /**
   * Reproduit le contrat reel (voir PrismaPlanUpgradeRequestRepository) : supprime d'abord une
   * eventuelle demande EXPIREE du meme abonnement, puis refuse l'insertion si une demande NON
   * expiree subsiste — ce qui, en base, est impose par la contrainte UNIQUE `subscription_id`.
   */
  async replaceExpiredAndInsert(request: PlanUpgradeRequest, tenantId: TenantId, now: Date): Promise<void> {
    if (!request.tenantId.equals(tenantId)) {
      throw new Error("Tentative d'ecriture d'une PlanUpgradeRequest hors du tenant du contexte courant.");
    }
    for (const [key, existing] of this.requests) {
      if (!existing.subscriptionId.equals(request.subscriptionId)) {
        continue;
      }
      if (existing.isExpired(now)) {
        this.requests.delete(key);
        continue;
      }
      throw new PlanUpgradeRequestConflictError(
        `Une demande d'upgrade non expiree existe deja pour l'abonnement ${request.subscriptionId.toString()}.`,
      );
    }
    this.requests.set(request.id.toString(), request);
  }

  async delete(id: string, tenantId: TenantId): Promise<void> {
    const request = this.requests.get(id);
    if (request !== undefined && request.tenantId.equals(tenantId)) {
      this.requests.delete(id);
    }
  }

  /** Outil de test : nombre de demandes en attente, toutes tenants confondus. */
  count(): number {
    return this.requests.size;
  }
}

/** Fake du port `SubscriptionAuditTrail` (ADR-0009 §2.2/§4) — accumule les entrees enregistrees, sans I/O. */
export class InMemorySubscriptionAuditTrail implements SubscriptionAuditTrail {
  public readonly records: SubscriptionAuditRecordInput[] = [];

  async record(input: SubscriptionAuditRecordInput): Promise<void> {
    this.records.push(input);
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
