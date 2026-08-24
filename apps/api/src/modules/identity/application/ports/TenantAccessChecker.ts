import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';

/**
 * Statut d'acces d'un tenant, du point de vue d'Identity — vocabulaire propre a Identity, PAS
 * une reexportation du statut du domain HealthFacility (`FacilityStatus`) que ce module
 * n'importe jamais (regle dependency-cruiser `no-cross-module-domain-import`). C'est a
 * l'implementation reelle du port (composition-root.ts) de traduire le statut Tenant vers ce
 * contrat, jamais l'inverse : Identity ne connait et ne doit connaitre que ces trois valeurs.
 *
 * - `ACCESSIBLE` : le tenant existe et un nouveau contexte de session peut s'ouvrir normalement.
 * - `NOT_FOUND` : aucun tenant ne correspond a cet identifiant (voir ResolveTenantContext.ts).
 * - `SUSPENDED` : le tenant existe mais son statut interdit l'ouverture d'un NOUVEAU contexte
 *   (arbitrage architecte du 2026-08-24 : distinguer explicitement le statut du tenant de
 *   l'etat d'acces/session, plutot qu'un `if suspended` fige dans le handler). Ne bloque QUE
 *   l'ouverture d'un nouveau contexte — jamais les sessions deja ouvertes, jamais une donnee
 *   medicale. Ne prejuge pas d'un futur "mode degrade" (O-03) : ce dernier restera une decision
 *   du futur module Subscription, qui composera avec ce statut sans le remplacer (voir le
 *   commentaire sur `FacilityStatus` dans modules/tenant/domain/HealthFacility.ts).
 */
export type TenantAccessStatus = 'ACCESSIBLE' | 'NOT_FOUND' | 'SUSPENDED';

/**
 * Port explicite (01-target-architecture.md §5 : "un module n'importe jamais le domain/ d'un
 * autre module ; les echanges passent par des evenements ou des ports explicites"). Permet a
 * `ResolveTenantContextHandler` de verifier l'accessibilite d'un tenant avant d'ouvrir un
 * contexte de session, SANS qu'Identity importe `modules/tenant/domain/HealthFacility.ts`.
 *
 * L'implementation reelle (qui delegue au `HealthFacilityRepository` du module Tenant) n'est
 * cablee nulle part dans Identity ni dans Tenant : elle est definie directement dans
 * `composition-root.ts`, seul endroit du code autorise a connaitre les deux modules a la fois.
 */
export interface TenantAccessChecker {
  checkAccess(tenantId: TenantId): Promise<TenantAccessStatus>;
}
