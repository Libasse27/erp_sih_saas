/**
 * Garde-fou de deduplication des tentatives de contournement MFA (ADR-0005 §4 : "dedupliqué par
 * session — une seule entree par sessionId en attente, dans la fenetre de la session"). Vit dans
 * `application/ports/` (comme `SessionStore`) : l'implementation reelle (infrastructure/,
 * Redis `SET NX EX`) est un detail technique, `ServerContextResolver` ne connait que ce contrat.
 */
export interface MfaBypassAttemptGuard {
  /**
   * Retourne `true` la PREMIERE fois qu'il est appele pour ce `sessionId` dans la fenetre
   * `windowSeconds` (l'appelant doit alors enregistrer l'entree d'audit) ; `false` les appels
   * suivants dans la meme fenetre (deja enregistre, ne pas dupliquer).
   */
  tryMark(sessionId: string, windowSeconds: number): Promise<boolean>;
}
