import type { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import type { PaymentMethod } from '../value-objects/PaymentMethod.js';

/**
 * Port sortant vers le prestataire de paiement SaaS (O-25.3) — AUCUN FOURNISSEUR REEL CODE EN
 * DUR (residu explicite : "Fournisseur de paiement SaaS", 03-open-decisions.md O-25).
 * L'implementation infrastructure/ EST l'Anti-Corruption Layer (D10) : aucun type ni concept
 * specifique au fournisseur ne doit apparaitre dans cette interface ni dans les types
 * domain/application qui l'utilisent — uniquement Money, TenantId, chaines opaques (identifiants
 * de transaction, signatures).
 *
 * Contraintes fixees par l'ADR pour CE port, quel que soit le prestataire choisi plus tard
 * (O-25.3) : Mobile Money + carte, paiement recurrent/tokenise, webhooks signes, idempotence,
 * sandbox, reglement XOF si possible. Le "paiement recurrent/tokenise" n'est PAS exploite par
 * cette etape (voir residu documente sur l'auto-charge de renouvellement, rapport de fin de
 * tache) — le contrat le permet, l'orchestration V1 ne le declenche pas encore automatiquement.
 */
export interface InitiatePaymentRequest {
  readonly tenantId: string;
  /** Cle d'idempotence CÔTE NOUS (notre `Payment.id`) — evite une double initiation si l'appel HTTP sortant est retente apres timeout (§6.3 resilience : "uniquement sur idempotent + 5xx/timeout"). */
  readonly idempotencyKey: string;
  readonly amount: Money;
  readonly method: PaymentMethod;
}

export interface InitiatePaymentResult {
  /** Identifiant de transaction attribue par le prestataire — cle d'idempotence webhook (O-25.5). */
  readonly providerTransactionId: string;
  /** URL de redirection/checkout (mobile money, 3-D Secure carte...) — absente si le sandbox confirme instantanement. */
  readonly redirectUrl: string | null;
}

export type ProviderWebhookOutcome = 'SUCCEEDED' | 'FAILED';

export interface ProviderWebhookEvent {
  readonly providerTransactionId: string;
  readonly outcome: ProviderWebhookOutcome;
  readonly occurredAt: Date;
  /**
   * Montant tel que RAPPORTE PAR LE PRESTATAIRE pour cette transaction — jamais recalcule ni
   * devine cote nous a cet endroit (l'ACL se contente de traduire ce que le prestataire affirme).
   * Sert de defense en profondeur cote `ConfirmPayment.ts` : comparer ce montant a celui du
   * `Payment` retrouve AVANT d'appliquer un succes, pour detecter un webhook qui porterait sur la
   * bonne transaction mais un mauvais montant (payload corrompu, confusion cote prestataire).
   */
  readonly amount: Money;
}

export type ProviderTransactionStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'NOT_FOUND';

export interface PaymentProvider {
  initiatePayment(request: InitiatePaymentRequest): Promise<InitiatePaymentResult>;

  /**
   * Verifie la signature d'un webhook entrant (O-25.5 : "signature obligatoire, rejet silencieux
   * si absente/invalide"). `rawBody` DOIT etre le corps HTTP brut (pas le JSON re-serialise) —
   * une signature HMAC porte sur les octets exacts recus.
   */
  verifyWebhookSignature(params: { rawBody: string; signatureHeader: string | undefined }): boolean;

  /** Traduit le payload brut (deja verifie) vers le contrat neutre `ProviderWebhookEvent` — aucun champ specifique au fournisseur ne fuit au-dela de cette methode. `null` si le payload est illisible (JSON malforme, champs requis absents). */
  parseWebhookPayload(rawBody: string): ProviderWebhookEvent | null;

  /** Rapprochement periodique (O-25.5 : "le webhook n'est jamais l'unique source de verite") — interroge directement l'API du prestataire pour un `providerTransactionId` donne. */
  reconcileTransaction(providerTransactionId: string): Promise<ProviderTransactionStatus>;
}
