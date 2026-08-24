import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { Subscription } from '../../domain/Subscription.js';
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository.js';
import type { BillingPeriod } from '../../domain/value-objects/BillingPeriod.js';
import { PlanId } from '../../domain/value-objects/PlanId.js';
import { PlanPriceId } from '../../domain/value-objects/PlanPriceId.js';
import { SubscriptionId } from '../../domain/value-objects/SubscriptionId.js';
import type { SubscriptionStatus } from '../../domain/value-objects/SubscriptionStatus.js';

interface SubscriptionRow {
  id: string;
  tenantId: string;
  planId: string;
  currentPlanPriceId: string;
  period: string;
  status: string;
  trialEndsAt: Date | null;
  periodStartsAt: Date;
  periodEndsAt: Date;
  createdAt: Date;
}

/**
 * Repository `Subscription` — table `platform.Subscription`, `tenant_id` colonne simple,
 * EXPLICITEMENT SANS RLS (ADR-0001 §3.3). Chaque methode filtre `tenant_id` EN PLUS de l'id
 * quand un id est fourni : contrairement aux tables `public/` protegees par RLS FORCE (couche 4
 * de rattrapage), CE FILTRE EST ICI LA SEULE BARRIERE — un oubli sur cette classe serait une
 * fuite inter-tenant reelle et immediate, pas seulement une degradation de la defense en
 * profondeur. Voir test/subscription/integration/subscriptionRepositoryTenantIsolation.test.ts,
 * qui le demontre explicitement en interrogeant volontairement avec un tenantId different du
 * proprietaire reel.
 */
export class PrismaSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByTenantId(tenantId: TenantId): Promise<Subscription | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.subscription.findFirst({ where: { tenantId: tenantId.toString() } });
    return row === null ? null : this.toDomain(row);
  }

  async findById(id: SubscriptionId, tenantId: TenantId): Promise<Subscription | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.subscription.findFirst({
      where: { id: id.toString(), tenantId: tenantId.toString() },
    });
    return row === null ? null : this.toDomain(row);
  }

  async save(subscription: Subscription, tenantId: TenantId): Promise<void> {
    if (!subscription.tenantId.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'un Subscription hors du tenant du contexte courant.");
    }
    const client = resolvePrismaClient(this.prisma);
    const idStr = subscription.id.toString();
    const tenantIdStr = tenantId.toString();

    // `where: { id }` seul (pas de composite avec tenantId) : suffisant et coherent avec
    // PrismaHealthFacilityRepository.save / PrismaUserTenantMembershipRepository.save — l'
    // appartenance au bon tenant est deja verifiee ci-dessus (`equals`), `id` est la cle
    // primaire donc globalement unique, aucune ecriture croisee n'est possible ici.
    await client.subscription.upsert({
      where: { id: idStr },
      create: {
        id: idStr,
        tenantId: tenantIdStr,
        planId: subscription.planId.toString(),
        currentPlanPriceId: subscription.currentPlanPriceId.toString(),
        period: subscription.period,
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        periodStartsAt: subscription.periodStartsAt,
        periodEndsAt: subscription.periodEndsAt,
        createdAt: subscription.createdAt,
      },
      update: {
        planId: subscription.planId.toString(),
        currentPlanPriceId: subscription.currentPlanPriceId.toString(),
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
      },
    });
  }

  private toDomain(row: SubscriptionRow): Subscription {
    const id = assertValid(SubscriptionId.create(row.id));
    const tenantId = assertValid(TenantId.create(row.tenantId));
    const planId = assertValid(PlanId.create(row.planId));
    const currentPlanPriceId = assertValid(PlanPriceId.create(row.currentPlanPriceId));
    return Subscription.reconstitute(id, {
      tenantId,
      planId,
      currentPlanPriceId,
      period: row.period as BillingPeriod,
      status: row.status as SubscriptionStatus,
      trialEndsAt: row.trialEndsAt,
      periodStartsAt: row.periodStartsAt,
      periodEndsAt: row.periodEndsAt,
      createdAt: row.createdAt,
    });
  }
}
