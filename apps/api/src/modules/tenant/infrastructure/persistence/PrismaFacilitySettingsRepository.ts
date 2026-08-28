import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { FacilitySettings } from '../../domain/FacilitySettings.js';
import type { FacilitySettingsRepository } from '../../domain/ports/FacilitySettingsRepository.js';
import { FacilitySettingsId } from '../../domain/value-objects/FacilitySettingsId.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { writeDomainEventsToOutbox } from '../../../../shared-kernel/infrastructure/persistence/OutboxWriter.js';

interface FacilitySettingsRow {
  id: string;
  tenantId: string;
  locale: string;
  timezone: string;
  currency: string;
  phoneCountryCode: string;
  createdAt: Date;
  provisioningCompletedAt: Date | null;
}

/**
 * Repository `FacilitySettings` — table tenant-scoped, RLS FORCE (voir migration SQL). Chaque
 * methode filtre explicitement sur `tenant_id` (couche 3 de la defense en profondeur, ADR-0001
 * §3.2), meme discipline que `PrismaHealthFacilityRepository`.
 */
export class PrismaFacilitySettingsRepository implements FacilitySettingsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByTenantId(tenantId: TenantId): Promise<FacilitySettings | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.facilitySettings.findFirst({
      where: { tenantId: tenantId.toString() },
    });
    return row === null ? null : this.toDomain(row);
  }

  async save(settings: FacilitySettings, tenantId: TenantId): Promise<void> {
    if (!settings.tenantId.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'un FacilitySettings hors du tenant du contexte courant.");
    }
    const client = resolvePrismaClient(this.prisma);
    const idStr = settings.id.toString();

    await client.facilitySettings.upsert({
      where: { id: idStr },
      create: {
        id: idStr,
        tenantId: tenantId.toString(),
        locale: settings.locale,
        timezone: settings.timezone,
        currency: settings.currency,
        phoneCountryCode: settings.phoneCountryCode,
        createdAt: settings.createdAt,
        provisioningCompletedAt: settings.provisioningCompletedAt,
      },
      update: {
        provisioningCompletedAt: settings.provisioningCompletedAt,
      },
    });

    // Outbox (D9, etape 6/13) : ecrit DANS LA MEME TRANSACTION que la ligne ci-dessus (meme
    // `client` resolu via `resolvePrismaClient`) — les deux appelants de `save()`
    // (SeedFacilityConfigurationHandler, CompleteProvisioningHandler) executent deja sous
    // `unitOfWork.withTransaction`. Active ici le relais pour `FacilityConfigurationSeeded`/
    // `ProvisioningCompleted`.
    await writeDomainEventsToOutbox(client, settings.pullDomainEvents());
  }

  private toDomain(row: FacilitySettingsRow): FacilitySettings {
    const id = assertValid(FacilitySettingsId.create(row.id));
    const tenantId = assertValid(TenantId.create(row.tenantId));
    return FacilitySettings.reconstitute(id, {
      tenantId,
      locale: row.locale,
      timezone: row.timezone,
      currency: row.currency,
      phoneCountryCode: row.phoneCountryCode,
      createdAt: row.createdAt,
      provisioningCompletedAt: row.provisioningCompletedAt,
    });
  }
}
