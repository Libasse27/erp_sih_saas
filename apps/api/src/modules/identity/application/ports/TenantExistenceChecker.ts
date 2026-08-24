import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';

/**
 * Port explicite (01-target-architecture.md §5 : "un module n'importe jamais le domain/ d'un
 * autre module ; les echanges passent par des evenements ou des ports explicites"). Permet a
 * `ResolveTenantContextHandler` de verifier qu'un tenant existe reellement avant d'ouvrir un
 * contexte de session, SANS qu'Identity importe `modules/tenant/domain/HealthFacility.ts` —
 * import qui violerait la regle dependency-cruiser `no-cross-module-domain-import` ajoutee avec
 * ce module (voir .dependency-cruiser.cjs).
 *
 * L'implementation reelle (qui delegue au `HealthFacilityRepository` du module Tenant) n'est
 * cablee nulle part dans Identity ni dans Tenant : elle est definie directement dans
 * `composition-root.ts`, seul endroit du code autorise a connaitre les deux modules a la fois.
 */
export interface TenantExistenceChecker {
  exists(tenantId: TenantId): Promise<boolean>;
}
