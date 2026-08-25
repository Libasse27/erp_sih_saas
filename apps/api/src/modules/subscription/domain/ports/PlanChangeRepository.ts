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
  /**
   * CHANGEMENT DE CONTRAT (passe 2) : `append` est desormais IDEMPOTENT PAR CLE PRIMAIRE — un
   * conflit sur `id` est un NO-OP SILENCIEUX, jamais une erreur. Ce n'est pas un relachement de
   * rigueur mais la consequence directe du fait que `id` n'est plus genere au moment de l'ecriture :
   * c'est le `PlanChangeId` PRE-ATTRIBUE a la demande d'upgrade (voir PlanUpgradeRequest.ts), donc
   * une valeur PREVISIBLE, ecrite par un consommateur Outbox at-least-once
   * (`ApplyPlanUpgradeOnPaymentSucceeded.ts`). Une re-livraison du meme `SaaSPaymentSucceeded` doit
   * retrouver la ligne deja ecrite sans echouer — et comme cette entite est immuable, "la ligne
   * existe deja avec cet id" signifie necessairement "exactement le meme contenu".
   */
  append(change: PlanChange, tenantId: TenantId): Promise<void>;

  /**
   * Retrouve une ligne d'historique par son identifiant. `id` est une CHAINE (pas un
   * `PlanChangeId`) : elle provient d'un payload d'evenement Outbox (`sourceReference`), frontiere
   * non fiable — l'implementation valide et renvoie `null` si la valeur n'est pas recevable.
   * Utilise par `ApplyPlanUpgradeOnPaymentSucceeded.ts` pour distinguer "re-livraison d'un upgrade
   * DEJA applique" (la ligne existe) d'un "paiement orphelin" (elle n'existe pas).
   */
  findById(id: string, tenantId: TenantId): Promise<PlanChange | null>;

  listBySubscriptionId(subscriptionId: SubscriptionId, tenantId: TenantId): Promise<readonly PlanChange[]>;
}
