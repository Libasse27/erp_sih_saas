import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { PlanPrice } from '../../domain/PlanPrice.js';
import type { PlanPriceRepository } from '../../domain/ports/PlanPriceRepository.js';
import type { BillingPeriod } from '../../domain/value-objects/BillingPeriod.js';
import { PlanId } from '../../domain/value-objects/PlanId.js';
import { PlanPriceId } from '../../domain/value-objects/PlanPriceId.js';

interface PlanPriceRow {
  id: string;
  planId: string;
  amount: number;
  period: string;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Repository `PlanPrice` — schema `platform`, hors RLS tenant. Append-only : `save` n'appelle
 * jamais `upsert`/`update`, uniquement `create` — une tentative d'ecriture d'un `id` deja
 * existant echoue au niveau base (contrainte de cle primaire), ce qui est le comportement
 * voulu (voir domain/PlanPrice.ts).
 */
export class PrismaPlanPriceRepository implements PlanPriceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: PlanPriceId): Promise<PlanPrice | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.planPrice.findUnique({ where: { id: id.toString() } });
    return row === null ? null : this.toDomain(row);
  }

  async findEffectivePrice(planId: PlanId, period: BillingPeriod, asOf: Date): Promise<PlanPrice | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.planPrice.findFirst({
      where: { planId: planId.toString(), period, effectiveFrom: { lte: asOf } },
      orderBy: { effectiveFrom: 'desc' },
    });
    return row === null ? null : this.toDomain(row);
  }

  async save(price: PlanPrice): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    await client.planPrice.create({
      data: {
        id: price.id.toString(),
        planId: price.planId.toString(),
        amount: price.amount.amount,
        period: price.period,
        effectiveFrom: price.effectiveFrom,
        createdAt: price.createdAt,
      },
    });
  }

  private toDomain(row: PlanPriceRow): PlanPrice {
    const id = assertValid(PlanPriceId.create(row.id));
    const planId = assertValid(PlanId.create(row.planId));
    const amount = assertValid(Money.fromXOF(row.amount));
    return PlanPrice.reconstitute(id, {
      planId,
      amount,
      period: row.period as BillingPeriod,
      effectiveFrom: row.effectiveFrom,
      createdAt: row.createdAt,
    });
  }
}
