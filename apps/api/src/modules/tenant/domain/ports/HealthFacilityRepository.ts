import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { HealthFacility } from '../HealthFacility.js';

/**
 * Port de persistance pour `HealthFacility` — table tenant-scoped, protegee par RLS FORCE
 * (infrastructure/). Couche 3 de la defense en profondeur (ADR-0001 §3.2) : meme si `id` et
 * `tenantId` sont ici la MEME valeur (voir HealthFacility.ts), chaque methode recoit et filtre
 * explicitement sur `tenantId` dans l'implementation, jamais uniquement sur `id` — pour rester
 * uniforme avec le reste du code et ne jamais deleguer ce filtrage au seul RLS.
 */
export interface HealthFacilityRepository {
  findByTenantId(tenantId: TenantId): Promise<HealthFacility | null>;

  existsByTenantId(tenantId: TenantId): Promise<boolean>;

  save(facility: HealthFacility, tenantId: TenantId): Promise<void>;
}
