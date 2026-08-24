import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlanChange } from '../../domain/PlanChange.js';
import type { PlanChangeRepository } from '../../domain/ports/PlanChangeRepository.js';
import { PlanChangeId } from '../../domain/value-objects/PlanChangeId.js';
import type { PlanChangeType } from '../../domain/value-objects/PlanChangeType.js';
import { PlanId } from '../../domain/value-objects/PlanId.js';
import { PlanPriceId } from '../../domain/value-objects/PlanPriceId.js';
import { SubscriptionId } from '../../domain/value-objects/SubscriptionId.js';

interface PlanChangeRow {
  id: string;
  subscriptionId: string;
  tenantId: string;
  changeType: string;
  fromPlanId: string;
  fromPlanPriceId: string;
  toPlanId: string;
  toPlanPriceId: string;
  proratedAmount: number;
  occurredAt: Date;
}

/**
 * Repository `PlanChange` — table `platform.SubscriptionPlanChange`, `tenant_id` colonne simple,
 * SANS RLS (meme regime que `PrismaSubscriptionRepository.ts` : filtrage explicite par
 * `tenantId` = seule barriere inter-tenant reelle sur cette table).
 */
export class PrismaPlanChangeRepository implements PlanChangeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(change: PlanChange, tenantId: TenantId): Promise<void> {
    if (!change.tenantId.equals(tenantId)) {
      throw new Error("Tentative d'ajout d'un PlanChange hors du tenant du contexte courant.");
    }
    const client = resolvePrismaClient(this.prisma);
    await client.subscriptionPlanChange.create({
      data: {
        id: change.id.toString(),
        subscriptionId: change.subscriptionId.toString(),
        tenantId: tenantId.toString(),
        changeType: change.changeType,
        fromPlanId: change.fromPlanId.toString(),
        fromPlanPriceId: change.fromPlanPriceId.toString(),
        toPlanId: change.toPlanId.toString(),
        toPlanPriceId: change.toPlanPriceId.toString(),
        proratedAmount: change.proratedAmount.amount,
        occurredAt: change.occurredAt,
      },
    });
  }

  async listBySubscriptionId(subscriptionId: SubscriptionId, tenantId: TenantId): Promise<readonly PlanChange[]> {
    const client = resolvePrismaClient(this.prisma);
    const rows = await client.subscriptionPlanChange.findMany({
      where: { subscriptionId: subscriptionId.toString(), tenantId: tenantId.toString() },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((row) => this.toDomain(row));
  }

  private toDomain(row: PlanChangeRow): PlanChange {
    const id = assertValid(PlanChangeId.create(row.id));
    const subscriptionId = assertValid(SubscriptionId.create(row.subscriptionId));
    const tenantId = assertValid(TenantId.create(row.tenantId));
    const fromPlanId = assertValid(PlanId.create(row.fromPlanId));
    const fromPlanPriceId = assertValid(PlanPriceId.create(row.fromPlanPriceId));
    const toPlanId = assertValid(PlanId.create(row.toPlanId));
    const toPlanPriceId = assertValid(PlanPriceId.create(row.toPlanPriceId));
    const proratedAmount = assertValid(Money.fromXOF(row.proratedAmount));
    return PlanChange.reconstitute(id, {
      subscriptionId,
      tenantId,
      changeType: row.changeType as PlanChangeType,
      fromPlanId,
      fromPlanPriceId,
      toPlanId,
      toPlanPriceId,
      proratedAmount,
      occurredAt: row.occurredAt,
    });
  }
}
