/**
 * Types d'evenement d'audit MFA (ADR-0005 §5-6, O-04.7). Cette union est primitive et
 * deliberement DUPLIQUEE de `modules/audit/domain/value-objects/AuditEventType.ts` (jamais
 * importee depuis `identity` : un module n'importe jamais le domain/ d'un autre module,
 * 01-target-architecture.md §5). `composition-root.ts` est le SEUL point du code autorise a
 * traduire cette union primitive vers les VO du module `audit`.
 */
export type MfaAuditEventType =
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

export interface AuditRecordInput {
  readonly eventType: MfaAuditEventType;
  readonly outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  readonly tenantId: string | null;
  readonly subjectUserId: string;
  readonly actorUserId: string;
  readonly actorRoleCodes: readonly string[];
  /** Texte libre — UNIQUEMENT pour `MFA_RE_ENROLLMENT_FORCED` (ADR-0005 §6) ; `null` sinon. */
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
}

/**
 * Port sortant d'Identity vers le module `audit` (ADR-0005 §5). L'implementation reelle est
 * cablee dans `composition-root.ts` (seul point du code autorise a connaitre les deux modules a
 * la fois, meme raisonnement que `TenantAccessChecker`/`TenantModuleBackedAccessChecker`).
 *
 * NON NEGOCIABLE : `record()` DOIT etre appele DANS LA TRANSACTION COURANTE (via
 * `resolvePrismaClient`/AsyncLocalStorage, comme tout repository Prisma) — JAMAIS depuis un
 * consommateur Outbox. Un echec metier (`Result.failure`) doit tout de meme produire une entree
 * d'audit committee ; seule une exception technique annule tout (voir ADR-0005 §5, raisons 1-3).
 */
export interface AuditTrail {
  record(input: AuditRecordInput): Promise<void>;
}
