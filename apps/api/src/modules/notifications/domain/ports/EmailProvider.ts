/**
 * Port sortant vers le fournisseur d'envoi Email (O-07.1) — AUCUN FOURNISSEUR REEL CODE EN DUR
 * (ADR-0007 §3 : aucun fournisseur choisi, meme regime que `PaymentProvider`/O-25.3).
 * L'implementation infrastructure/ EST l'Anti-Corruption Layer (D10) : aucun type ni concept
 * specifique au fournisseur ne doit apparaitre dans cette interface.
 */
export interface EmailSendRequest {
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
  /** Cle d'idempotence COTE NOUS (`Notification.id`) — permet a un fournisseur reel qui l'exploite d'eviter un double envoi cote son API si l'appel sortant est retente. */
  readonly idempotencyKey: string;
}

export interface EmailSendResult {
  /** Identifiant attribue par le fournisseur — conserve sur `Notification.providerMessageId`. */
  readonly providerMessageId: string;
}

export interface EmailProvider {
  /** Leve `NotificationDeliveryError` (jamais un rejet silencieux) — `retryable` distingue une erreur definitive d'une erreur transitoire (ADR-0007 §5). */
  send(request: EmailSendRequest): Promise<EmailSendResult>;
}
