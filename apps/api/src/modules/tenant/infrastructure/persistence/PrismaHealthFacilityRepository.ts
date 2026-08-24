import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { HealthFacility } from '../../domain/HealthFacility.js';
import type { HealthFacilityRepository } from '../../domain/ports/HealthFacilityRepository.js';
import { FacilityName } from '../../domain/value-objects/FacilityName.js';
import type { FacilityStatus } from '../../domain/value-objects/FacilityStatus.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';

interface HealthFacilityRow {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  createdAt: Date;
}

/**
 * Repository `HealthFacility` — table tenant-scoped, RLS FORCE (voir migration SQL). Chaque
 * methode filtre explicitement sur `tenant_id` (couche 3 de la defense en profondeur, ADR-0001
 * §3.2) — le RLS Postgres est le filet de securite, jamais le seul filtre, meme si `id` et
 * `tenant_id` portent ici la meme valeur (voir HealthFacilityRepository.ts).
 */
export class PrismaHealthFacilityRepository implements HealthFacilityRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByTenantId(tenantId: TenantId): Promise<HealthFacility | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.healthFacility.findFirst({
      where: { id: tenantId.toString(), tenantId: tenantId.toString() },
    });
    return row === null ? null : this.toDomain(row);
  }

  async existsByTenantId(tenantId: TenantId): Promise<boolean> {
    const client = resolvePrismaClient(this.prisma);
    const count = await client.healthFacility.count({
      where: { id: tenantId.toString(), tenantId: tenantId.toString() },
    });
    return count > 0;
  }

  async save(facility: HealthFacility, tenantId: TenantId): Promise<void> {
    if (!facility.id.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'un HealthFacility hors du tenant du contexte courant.");
    }
    const client = resolvePrismaClient(this.prisma);
    const idStr = facility.id.toString();

    await client.healthFacility.upsert({
      where: { id: idStr },
      create: {
        id: idStr,
        tenantId: idStr,
        name: facility.name.value,
        status: facility.status,
        createdAt: facility.createdAt,
      },
      update: {
        name: facility.name.value,
        status: facility.status,
      },
    });
  }

  private toDomain(row: HealthFacilityRow): HealthFacility {
    const id = assertValid(TenantId.create(row.id));
    const name = assertValid(FacilityName.create(row.name));
    return HealthFacility.reconstitute(id, {
      name,
      status: row.status as FacilityStatus,
      createdAt: row.createdAt,
    });
  }
}
