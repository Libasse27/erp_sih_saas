import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { FacilitySettings } from '../FacilitySettings.js';

/**
 * Port de persistance pour `FacilitySettings` — table tenant-scoped, protegee par RLS FORCE
 * (infrastructure/), UNE ligne au plus par tenant (contrainte UNIQUE `tenant_id`, voir migration
 * SQL). Couche 3 de la defense en profondeur (ADR-0001 §3.2) : chaque methode filtre
 * explicitement sur `tenantId`, jamais uniquement sur `id` — meme discipline que
 * `HealthFacilityRepository`.
 */
export interface FacilitySettingsRepository {
  findByTenantId(tenantId: TenantId): Promise<FacilitySettings | null>;

  save(settings: FacilitySettings, tenantId: TenantId): Promise<void>;
}
