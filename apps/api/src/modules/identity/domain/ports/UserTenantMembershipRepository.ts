import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { UserTenantMembership } from '../UserTenantMembership.js';
import type { UserAccountId } from '../value-objects/UserAccountId.js';
import type { UserTenantMembershipId } from '../value-objects/UserTenantMembershipId.js';

/**
 * Port de persistance pour `UserTenantMembership` — table tenant-scoped, protegee par RLS
 * FORCE (infrastructure/). Couche 3 de la defense en profondeur (ADR-0001 §3.2) : chaque
 * methode qui lit ou ecrit une ligne tenant-scoped recoit `tenantId` en parametre **obligatoire**
 * et l'implementation DOIT filtrer explicitement dessus, sans jamais deleguer ce filtrage au
 * seul RLS.
 *
 * Exception unique et documentee : `listActiveTenantIdsForUser` est intentionnellement
 * transversale aux tenants — c'est la requete qui permet a un utilisateur authentifie (mais
 * pas encore contextualise dans un tenant) de savoir dans quels etablissements il peut ouvrir
 * un contexte (ecran de selection post-login, O-05). Elle reste scopee a **son propre**
 * `userId` (jamais a un `userId` arbitraire) et s'appuie sur une politique RLS additive dediee
 * (voir migration SQL) plutot que sur un contournement applicatif du RLS.
 */
export interface UserTenantMembershipRepository {
  findActiveByUserAndTenant(
    userId: UserAccountId,
    tenantId: TenantId,
  ): Promise<UserTenantMembership | null>;

  findById(id: UserTenantMembershipId, tenantId: TenantId): Promise<UserTenantMembership | null>;

  listActiveTenantIdsForUser(userId: UserAccountId): Promise<readonly TenantId[]>;

  /** Compte des memberships ACTIFS pour un tenant — jamais des roles (regle O-05 derivee, maxUsers). */
  countActive(tenantId: TenantId): Promise<number>;

  save(membership: UserTenantMembership, tenantId: TenantId): Promise<void>;
}
