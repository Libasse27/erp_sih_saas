import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { Subscription } from '../Subscription.js';
import type { SubscriptionId } from '../value-objects/SubscriptionId.js';

/**
 * Port de persistance pour `Subscription` — table `platform.Subscription`, `tenant_id` colonne
 * simple, EXPLICITEMENT SANS RLS (ADR-0001 §3.3 : les donnees de niveau plateforme, dont les
 * abonnements, vivent hors RLS tenant). Consequence directe et non negociable : chaque methode
 * DOIT filtrer explicitement par `tenantId`, car c'est ICI, dans l'implementation de ce port
 * (`infrastructure/persistence/PrismaSubscriptionRepository.ts`), et NULLE PART AILLEURS, que
 * repose la totalite de l'isolation inter-tenant sur cette table. Il n'existe aucune couche 4
 * (RLS) de rattrapage pour cette table — voir le test dedie
 * `test/subscription/integration/subscriptionRepositoryTenantIsolation.test.ts`, qui prouve que
 * le repository lui-meme n'expose jamais une ligne d'un autre tenant.
 */
export interface SubscriptionRepository {
  findByTenantId(tenantId: TenantId): Promise<Subscription | null>;

  findById(id: SubscriptionId, tenantId: TenantId): Promise<Subscription | null>;

  save(subscription: Subscription, tenantId: TenantId): Promise<void>;
}
