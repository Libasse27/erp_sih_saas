import type { AuditCategory } from './value-objects/AuditCategory.js';
import type { AuditEventType } from './value-objects/AuditEventType.js';
import type { AuditOutcome } from './value-objects/AuditOutcome.js';
import type { ActorKind } from './value-objects/ActorKind.js';
import type { AuditTargetType } from './value-objects/AuditTargetType.js';

/**
 * Parametres primitifs de construction d'une `AuditEntry` (miroir des parametres de
 * `AuditEntry.record()`) — type PARTAGE entre `infrastructure/AuditModule.ts` (le service
 * `recordEntry` l'expose) et `application/commands/RecordAuditAccess.ts` (qui l'invoque). Vit
 * dans `domain/` pour que ni l'application ni l'infrastructure n'aient a importer l'une depuis
 * l'autre (direction de dependance saine : domain <- application, domain <- infrastructure).
 */
export interface AuditEntryRecordParams {
  readonly category: AuditCategory;
  readonly eventType: AuditEventType;
  readonly outcome: AuditOutcome;
  readonly tenantId: string | null;
  readonly actorKind: ActorKind;
  readonly actorUserId: string | null;
  readonly actorRoleCodes: readonly string[];
  readonly subjectUserId: string | null;
  readonly targetType: AuditTargetType;
  readonly targetId: string | null;
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
}
