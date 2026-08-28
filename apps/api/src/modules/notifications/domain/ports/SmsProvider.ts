/**
 * Port sortant vers le fournisseur d'envoi SMS (O-07.1) — AUCUN FOURNISSEUR REEL CODE EN DUR
 * (residu explicite O-07.3 : "Fournisseur SMS", 03-open-decisions.md O-07). Meme regime que
 * `EmailProvider`/`PaymentProvider`.
 *
 * Aucun declencheur reel n'invoque ce port a cette etape (ADR-0007 §2 : aucun agregat ne porte de
 * numero de telephone) — construit et teste au niveau mecanique uniquement.
 */
export interface SmsSendRequest {
  readonly recipient: string;
  readonly text: string;
  readonly idempotencyKey: string;
}

export interface SmsSendResult {
  readonly providerMessageId: string;
}

export interface SmsProvider {
  send(request: SmsSendRequest): Promise<SmsSendResult>;
}
