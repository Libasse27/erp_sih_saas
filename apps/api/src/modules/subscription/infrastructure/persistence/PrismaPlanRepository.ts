import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { Plan } from '../../domain/Plan.js';
import type { PlanRepository } from '../../domain/ports/PlanRepository.js';
import type { PlanCode } from '../../domain/value-objects/PlanCode.js';
import { PlanId } from '../../domain/value-objects/PlanId.js';
import { PlanLimits } from '../../domain/value-objects/PlanLimits.js';
import { PlanName } from '../../domain/value-objects/PlanName.js';

interface PlanRow {
  id: string;
  code: string;
  name: string;
  maxUsers: number;
  maxBeds: number;
  createdAt: Date;
}

/** Repository `Plan` — schema `platform`, hors RLS tenant (aucune methode ne prend de tenantId, voir port). */
export class PrismaPlanRepository implements PlanRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: PlanId): Promise<Plan | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.plan.findUnique({ where: { id: id.toString() } });
    return row === null ? null : this.toDomain(row);
  }

  async findByCode(code: PlanCode): Promise<Plan | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.plan.findUnique({ where: { code } });
    return row === null ? null : this.toDomain(row);
  }

  async save(plan: Plan): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    await client.plan.upsert({
      where: { id: plan.id.toString() },
      create: {
        id: plan.id.toString(),
        code: plan.code,
        name: plan.name.value,
        maxUsers: plan.limits.maxUsers,
        maxBeds: plan.limits.maxBeds,
        createdAt: plan.createdAt,
      },
      update: {
        name: plan.name.value,
        maxUsers: plan.limits.maxUsers,
        maxBeds: plan.limits.maxBeds,
      },
    });
  }

  private toDomain(row: PlanRow): Plan {
    const id = assertValid(PlanId.create(row.id));
    const name = assertValid(PlanName.create(row.name));
    const limits = assertValid(PlanLimits.create(row.maxUsers, row.maxBeds));
    return Plan.reconstitute(id, {
      code: row.code as PlanCode,
      name,
      limits,
      createdAt: row.createdAt,
    });
  }
}
