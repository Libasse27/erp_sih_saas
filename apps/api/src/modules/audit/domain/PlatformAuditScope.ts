import type { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';

/**
 * Perimetre d'une lecture PLATEFORME (ADR-0009 §6) — discriminant OBLIGATOIRE, sans valeur par
 * defaut, traite par un `switch` exhaustif avec garde `never` (F-7) dans le repository :
 *   - `ALL` : plateforme + tous les tenants ;
 *   - `PLATFORM_ONLY` : `tenant_id IS NULL` EXPLICITEMENT — jamais un `null` traite comme joker ;
 *   - `TENANT` : le tenant demande, QUEL QU'IL SOIT (supervision SUPER_ADMIN — decision
 *     complementaire validee par le responsable technique, PLATFORM -> tenant arbitraire).
 */
export type PlatformAuditScope =
  | { readonly kind: 'ALL' }
  | { readonly kind: 'PLATFORM_ONLY' }
  | { readonly kind: 'TENANT'; readonly tenantId: TenantId };
