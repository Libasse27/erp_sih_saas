import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { Payment } from '../Payment.js';
import type { PaymentId } from '../value-objects/PaymentId.js';

/**
 * Fait partie du CONTRAT de `save()` (verrouillage optimiste, voir plus bas) — vit ici, sur le
 * port, et non dans `infrastructure/persistence/PrismaPaymentRepository.ts` : l'application
 * (`ConfirmPaymentHandler`/`ReconcilePendingPaymentsHandler`) doit pouvoir l'attraper par type
 * SANS importer une classe d'infrastructure (01-target-architecture.md §5 — l'application ne
 * depend que du domaine/des ports, jamais d'une implementation concrete). Toute implementation de
 * ce port doit lever CETTE erreur (pas une sous-classe locale) quand `save()` perd la course du
 * verrouillage optimiste.
 */
export class PaymentConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConcurrencyConflictError';
  }
}

export interface PaymentRepository {
  findById(id: PaymentId, tenantId: TenantId): Promise<Payment | null>;

  /**
   * Resolution par cle d'idempotence webhook (O-25.5) — SANS `tenantId` : le prestataire de
   * paiement, en tant que systeme EXTERNE, ne connait et ne fournit jamais notre `tenantId` dans
   * sa notification, seulement l'identifiant de transaction qu'IL a attribue. C'est ce
   * repository qui retrouve le `Payment` (et donc son tenant) a partir de cette seule cle —
   * jamais l'inverse. Un `providerTransactionId` inconnu renvoie `null` (voir
   * application/commands/ConfirmPayment.ts : rejet silencieux, §O-25.5).
   */
  findByProviderTransactionId(providerTransactionId: string): Promise<Payment | null>;

  /**
   * PEUT lever `PaymentConcurrencyConflictError` (voir ci-dessus) si `payment` a ete lu (via
   * `findById`/`findByProviderTransactionId`/`listPendingInitiatedBefore`) puis qu'un AUTRE writer
   * a deja modifie cette meme ligne entre-temps — verrouillage optimiste PUREMENT technique,
   * necessaire car `ConfirmPaymentHandler` (webhook) et `ReconcilePendingPaymentsHandler`
   * (rapprochement periodique) peuvent tous deux lire puis ecrire le MEME `Payment` PENDING
   * concurremment. Les DEUX appelants DOIVENT capturer cette erreur et relire/reappliquer/
   * re-sauvegarder (voir leurs commentaires respectifs) plutot que de la laisser remonter comme
   * un simple echec technique.
   */
  save(payment: Payment, tenantId: TenantId): Promise<void>;

  /**
   * Candidats au rapprochement periodique (O-25.5 : "le webhook n'est jamais l'unique source de
   * verite") — tous les `Payment` encore `PENDING` inities avant `olderThan`. Requete PLATEFORME
   * (tous tenants), meme role que `SubscriptionRepository.listSchedulerCandidates`.
   */
  listPendingInitiatedBefore(olderThan: Date): Promise<readonly Payment[]>;
}
