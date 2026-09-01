import type { AuditEntry } from '../../domain/AuditEntry.js';
import type { AuditEntryPage } from '../../domain/AuditPage.js';

/**
 * DTO explicite (regle §6 : aucune reponse d'API n'expose un document/agregat brut). Porte
 * EXACTEMENT les six questions de B1 (ADR-0009 §1) — "qui / quoi / quand / sur quel tenant / avec
 * quel resultat / depuis quel contexte" — jamais les champs internes de chainage
 * (`chainSequence`/`previousEntryHash`/`entryHash`) : cette etape n'expose aucune interface de
 * verification (B2, §5.4 — `VerifyAuditChainIntegrity` n'est pas expose en HTTP).
 *
 * `sessionRef` (correctif securite 2026-09-01, ADR-0009 §3.1/§8.1) — JAMAIS `sessionId` : une
 * reference DERIVEE non reversible, jamais le jeton de session vivant. Republier `sessionId` ici
 * etait le dernier maillon du defaut corrige (un jeton rejouable quittait le serveur dans une
 * reponse HTTP de lecture).
 */
export interface AuditEntryDto {
  readonly id: string;
  readonly category: string;
  readonly eventType: string;
  readonly outcome: string;
  readonly tenantId: string | null;
  readonly actorKind: string;
  readonly actorUserId: string | null;
  readonly actorRoleCodes: readonly string[];
  readonly subjectUserId: string | null;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly reason: string | null;
  readonly sessionRef: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: string;
}

export interface AuditEntryListResponse {
  readonly entries: readonly AuditEntryDto[];
  readonly nextCursor: string | null;
}

function toDto(entry: AuditEntry): AuditEntryDto {
  return {
    id: entry.id.toString(),
    category: entry.category,
    eventType: entry.eventType,
    outcome: entry.outcome,
    tenantId: entry.tenantId,
    actorKind: entry.actorKind,
    actorUserId: entry.actorUserId,
    actorRoleCodes: entry.actorRoleCodes,
    subjectUserId: entry.subjectUserId,
    targetType: entry.targetType,
    targetId: entry.targetId,
    reason: entry.reason,
    sessionRef: entry.sessionRef,
    correlationId: entry.correlationId,
    occurredAt: entry.occurredAt.toISOString(),
  };
}

export function toAuditEntryListResponse(page: AuditEntryPage): AuditEntryListResponse {
  return { entries: page.entries.map(toDto), nextCursor: page.nextCursor };
}
