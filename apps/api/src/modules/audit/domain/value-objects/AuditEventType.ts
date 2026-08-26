/**
 * Types d'evenement journalises pour la categorie `MFA` (ADR-0005 §5-6, O-04.7). Miroir EXACT de
 * `modules/identity/application/ports/AuditTrail.ts::MfaAuditEventType` — dupliquation
 * deliberee (un module n'importe jamais le domain/ ni les ports applicatifs d'un autre module,
 * 01-target-architecture.md §5) ; `composition-root.ts` est le seul point du code qui traduit de
 * l'une vers l'autre.
 */
export type AuditEventType =
  | 'MFA_ENROLLMENT_STARTED'
  | 'MFA_ENROLLMENT_CONFIRMED'
  | 'MFA_FACTOR_REPLACED'
  | 'MFA_CHALLENGE_SUCCEEDED'
  | 'MFA_CHALLENGE_FAILED'
  | 'MFA_CHALLENGE_BLOCKED'
  | 'MFA_BYPASS_ATTEMPTED'
  | 'MFA_RECOVERY_CODE_CONSUMED'
  | 'MFA_RECOVERY_CODES_EXHAUSTED'
  | 'MFA_RECOVERY_CODES_REGENERATED'
  | 'MFA_RE_ENROLLMENT_FORCED'
  | 'MFA_FACTOR_LOCKED_OUT';
