/**
 * Port de hachage de la charge canonique d'une `AuditEntry` (ADR-0009 §5.2). Meme discipline que
 * `PasswordHasher`/`TotpService` (module `identity`) : le domaine ne connait qu'un contrat, jamais
 * `node:crypto` directement — condition pour que les tests unitaires du domaine restent
 * deterministes avec un hacheur factice (`FixedAuditEntryHasher`, voir les tests).
 *
 * L'implementation renvoie l'empreinte DEJA ENVELOPPEE `"v1.<sha256-base64url>"` (§5.2) —
 * l'enveloppe de version et le prefixe de domaine de hachage (`"audit-entry:v1|"`) sont la
 * responsabilite de l'implementation, jamais de l'appelant.
 */
export interface AuditEntryHasher {
  hash(canonicalPayload: string): string;
}
