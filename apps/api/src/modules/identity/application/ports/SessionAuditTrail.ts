/**
 * Types d'evenement d'audit SESSION (ADR-0006 §8, etape 8/13). Union primitive DUPLIQUEE de
 * `modules/audit/domain/value-objects/AuditEventType.ts` (jamais importee depuis `identity` : un
 * module n'importe jamais le domain/ d'un autre module) — meme discipline que
 * `AuditTrail.ts::MfaAuditEventType`. `composition-root.ts` est le SEUL point du code autorise a
 * traduire cette union primitive vers les VO du module `audit`.
 *
 * Port DEDIE, jamais une extension de `AuditTrail` (categorie `MFA`) : meme raisonnement
 * qu'ADR-0005 §5 (« un futur module qui ecrirait d'autres categories d'audit aurait son propre
 * adaptateur, jamais celui-ci etendu par un `if` sur l'appelant »).
 */
export type SessionAuditEventType =
  | 'SESSION_REFRESH_ROTATED'
  | 'SESSION_REFRESH_REUSE_DETECTED'
  | 'SESSION_REFRESH_REVOKED'
  | 'SESSION_ABSOLUTE_CEILING_EXCEEDED'
  | 'SESSION_INACTIVITY_TIMEOUT';

export interface SessionAuditRecordInput {
  readonly eventType: SessionAuditEventType;
  readonly outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  readonly tenantId: string | null;
  readonly subjectUserId: string;
  readonly actorUserId: string;
  readonly actorRoleCodes: readonly string[];
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
}

/**
 * Port sortant d'Identity vers le module `audit`, categorie `SESSION` (ADR-0006 §8). Meme
 * contrat transactionnel qu'`AuditTrail` : `record()` DOIT etre appele DANS la transaction
 * courante, jamais depuis un consommateur Outbox.
 */
export interface SessionAuditTrail {
  record(input: SessionAuditRecordInput): Promise<void>;
}
