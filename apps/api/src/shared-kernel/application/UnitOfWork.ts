import type { TenantId } from '../domain/value-objects/TenantId.js';

/**
 * Contexte de session PostgreSQL positionne par transaction, avant toute requete tenant-scoped
 * (couche 4 de la defense en profondeur, ADR-0001 §3.2).
 *
 * - `tenantId` : positionne `app.tenant_id` (`select set_config(...)`, jamais par
 *   interpolation de chaine) pour que la politique RLS `tenant_isolation` s'applique. Absent
 *   pour les operations structurellement sans tenant (authentification, niveau plateforme).
 * - `actorUserId` : positionne `app.user_id`. Necessaire pour l'unique requete transversale
 *   aux tenants autorisee dans ce module — un utilisateur authentifie qui liste ses propres
 *   memberships actifs avant d'avoir choisi un tenant (voir
 *   `UserTenantMembershipRepository.listActiveTenantIdsForUser`) — servie par une politique
 *   RLS additive dediee, jamais par un contournement du RLS.
 */
export interface UnitOfWorkContext {
  readonly tenantId?: TenantId;
  readonly actorUserId?: string;
}

/**
 * Port d'unite de travail : englobe la transaction PostgreSQL et la publication Outbox
 * dans la meme transaction (D9). Les implementations infrastructure/ portent le detail
 * (client PG, `SET LOCAL app.tenant_id` / `app.user_id` pour le RLS — ADR-0001 couche 4).
 */
export interface UnitOfWork {
  withTransaction<T>(work: () => Promise<T>, context?: UnitOfWorkContext): Promise<T>;
}
