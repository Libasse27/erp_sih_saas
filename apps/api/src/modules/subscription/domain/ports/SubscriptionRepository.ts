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
/**
 * Fait partie du CONTRAT de `save()` (verrouillage optimiste, voir plus bas) — vit ici, sur le
 * port, et non dans `infrastructure/persistence/PrismaSubscriptionRepository.ts` : l'application
 * doit pouvoir l'attraper par type SANS importer une classe d'infrastructure
 * (01-target-architecture.md §5). Replique EXACTE de `PaymentConcurrencyConflictError` (module
 * `payment`, ajoutee a la passe precedente) : meme raisonnement, meme discipline, meme obligation
 * pour toute implementation de lever CETTE erreur et pas une sous-classe locale.
 */
export class SubscriptionConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionConcurrencyConflictError';
  }
}

export interface SubscriptionRepository {
  findByTenantId(tenantId: TenantId): Promise<Subscription | null>;

  findById(id: SubscriptionId, tenantId: TenantId): Promise<Subscription | null>;

  /**
   * PEUT lever `SubscriptionConcurrencyConflictError` (voir ci-dessus) si `subscription` a ete lu
   * puis qu'un AUTRE writer a deja modifie cette meme ligne entre-temps — verrouillage optimiste
   * PUREMENT technique. TROIS writers concurrents existent depuis la passe 2 :
   * `ApplyPlanUpgradeOnPaymentSucceeded` (upgrade paye), `ReactivateSubscriptionOnPaymentSucceeded`
   * (reactivation/renouvellement sur paiement) et `ProcessSubscriptionRenewals` (scheduler). Sans
   * ce controle, le dernier `UPDATE` gagnant ecraserait silencieusement l'autre alors qu'un
   * evenement aurait deja ete ecrit dans l'Outbox.
   *
   * Chaque appelant DOIT traiter cette erreur explicitement, mais PAS de la meme facon : les
   * consommateurs Outbox relisent/reappliquent/re-sauvegardent (retry borne — leurs commandes de
   * domaine sont idempotentes), tandis que le scheduler SAUTE simplement l'abonnement concerne
   * pour ce cycle (le tick suivant le reevaluera). Voir les commentaires de chacun.
   */
  save(subscription: Subscription, tenantId: TenantId): Promise<void>;

  /**
   * Candidats scannes par le scheduler de renouvellement (`ProcessSubscriptionRenewals.ts`,
   * O-25.6) : abonnements potentiellement concernes par une transition automatique a l'instant
   * `now` — echeance atteinte (`TRIALING`/`ACTIVE` avec `periodEndsAt <= now`), grace en cours
   * (`GRACE_PERIOD`, quelle que soit l'anciennete), ou mode degrade pas encore signale "maintenu"
   * (`DEGRADED` avec `degradedModeSustainedNotifiedAt` NULL). Requete PLATEFORME (tous tenants,
   * AUCUN filtrage tenant) — coherent avec l'absence de RLS sur cette table (ADR-0001 §3.3) et le
   * role de ce scheduler : un processus de niveau plateforme, analogue au relais Outbox, jamais
   * appele dans le contexte d'une requete HTTP tenant-scopee.
   */
  listSchedulerCandidates(now: Date): Promise<readonly Subscription[]>;
}
