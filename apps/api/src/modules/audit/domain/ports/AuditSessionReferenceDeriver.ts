/**
 * Port de derivation de la reference de session (ADR-0009 §3.1, correctif securite 2026-09-01).
 * Meme discipline que `AuditEntryHasher` (§5.2) : le domaine ne connait qu'un contrat, jamais
 * `node:crypto` directement — condition pour que les tests unitaires du domaine restent
 * deterministes avec un dériveur factice.
 *
 * Le `sessionId` est un secret d'authentification (le jeton porte par `Authorization: Bearer`,
 * §3.1) : cette derivation est NON REVERSIBLE par construction (SHA-256, prefixe de domaine
 * `"audit-session:v1|"` DISTINCT de celui du chainage `"audit-entry:v1|"`, voir
 * `AuditEntryHasher`/`Sha256AuditEntryHasher`, §5.2 — deux usages cryptographiques differents ne
 * partagent jamais un espace de hachage). L'implementation renvoie la reference DEJA ENVELOPPEE
 * `"v1.<sha256-base64url>"`, jamais a l'appelant de le faire.
 *
 * `sessionId === null` (acteur `SYSTEM`, refus sans session, etc.) doit renvoyer `null` — aucune
 * session a correler.
 */
export interface AuditSessionReferenceDeriver {
  derive(sessionId: string | null): string | null;
}
