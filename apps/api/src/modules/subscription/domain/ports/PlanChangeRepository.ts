import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PlanChange } from '../PlanChange.js';
import type { SubscriptionId } from '../value-objects/SubscriptionId.js';

/**
 * Port de persistance pour `PlanChange` — historique append-only des changements de forfait
 * (table `platform.SubscriptionPlanChange`, `tenant_id` colonne simple, SANS RLS, meme regime
 * que `SubscriptionRepository.ts`). `append` (pas `save`) : le nom du contrat rend explicite
 * qu'aucune mise a jour d'une ligne existante n'est jamais attendue.
 */
export interface PlanChangeRepository {
  append(change: PlanChange, tenantId: TenantId): Promise<void>;

  listBySubscriptionId(subscriptionId: SubscriptionId, tenantId: TenantId): Promise<readonly PlanChange[]>;
}
