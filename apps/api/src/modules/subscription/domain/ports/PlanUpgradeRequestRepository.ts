import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PlanUpgradeRequest } from '../PlanUpgradeRequest.js';
import type { SubscriptionId } from '../value-objects/SubscriptionId.js';

/**
 * Fait partie du CONTRAT de `replaceExpiredAndInsert()` (voir plus bas) — vit ici, sur le port, et
 * non dans l'implementation Prisma : l'application (`UpgradeSubscriptionPlanHandler`) doit pouvoir
 * l'attraper PAR TYPE sans importer une classe d'infrastructure (01-target-architecture.md §5).
 * Meme discipline exactement que `PaymentConcurrencyConflictError` (module `payment`). Toute
 * implementation de ce port doit lever CETTE erreur (jamais une sous-classe locale) quand une
 * demande NON expiree existe deja pour l'abonnement vise.
 */
export class PlanUpgradeRequestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanUpgradeRequestConflictError';
  }
}

/**
 * Port de persistance pour `PlanUpgradeRequest` — table
 * `platform.SubscriptionPlanUpgradeRequest`, `tenant_id` colonne simple, SANS RLS (meme regime que
 * `SubscriptionRepository.ts` : le filtrage explicite par `tenantId` dans l'implementation est la
 * SEULE barriere inter-tenant reelle sur cette table).
 */
export interface PlanUpgradeRequestRepository {
  findBySubscriptionId(subscriptionId: SubscriptionId, tenantId: TenantId): Promise<PlanUpgradeRequest | null>;

  /**
   * Retrouve une demande par son identite (= le `PlanChangeId` pre-attribue). `id` est une CHAINE
   * et non un `PlanChangeId` : elle provient d'un payload d'evenement Outbox (`sourceReference`),
   * donc d'une frontiere non fiable — c'est a l'implementation de la valider et de renvoyer `null`
   * si elle n'est pas un identifiant recevable, jamais a l'appelant de supposer sa forme.
   */
  findById(id: string, tenantId: TenantId): Promise<PlanUpgradeRequest | null>;

  /**
   * Insere `request`, en remplacant ATOMIQUEMENT (dans la transaction deja ouverte par l'appelant)
   * une eventuelle demande EXPIREE pour le meme abonnement — une demande abandonnee ne doit jamais
   * bloquer indefiniment une nouvelle tentative.
   *
   * Leve `PlanUpgradeRequestConflictError` si une demande NON expiree existe deja. Ce contrat DOIT
   * etre non contournable par une course : l'implementation ne peut pas se contenter d'un
   * pre-controle applicatif "existe-t-il deja une demande ?", puisque deux requetes concurrentes
   * (double-clic, double soumission) le passeraient toutes deux avant que l'une n'insere. C'est la
   * contrainte UNIQUE `subscription_id` en base qui doit trancher, l'implementation se contentant
   * de traduire sa violation en cette erreur.
   */
  replaceExpiredAndInsert(request: PlanUpgradeRequest, tenantId: TenantId, now: Date): Promise<void>;

  /** Supprime la demande une fois l'upgrade applique (ou definitivement abandonne) — l'historique conserve est `PlanChange`, jamais cette table. */
  delete(id: string, tenantId: TenantId): Promise<void>;
}
