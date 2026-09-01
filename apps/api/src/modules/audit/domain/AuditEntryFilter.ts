import type { AuditCategory } from './value-objects/AuditCategory.js';
import type { AuditEventType } from './value-objects/AuditEventType.js';
import type { AuditOutcome } from './value-objects/AuditOutcome.js';
import type { ActorKind } from './value-objects/ActorKind.js';
import type { AuditTargetType } from './value-objects/AuditTargetType.js';

/**
 * Filtres de lecture du journal (ADR-0009 §6). NE PORTE AUCUN CHAMP DE TENANT — le perimetre
 * tenant est TOUJOURS un parametre POSITIONNEL et OBLIGATOIRE des methodes de liste
 * (`listForTenant(tenantId, ...)`/`listForPlatform(scope, ...)`), jamais un champ optionnel de ce
 * type (§6, alternative ecartee #4 : "un filtre tenant optionnel est precisement le mecanisme par
 * lequel une fuite arrive").
 */
export interface AuditEntryFilter {
  readonly categories?: readonly AuditCategory[];
  readonly eventTypes?: readonly AuditEventType[];
  readonly outcomes?: readonly AuditOutcome[];
  readonly actorKinds?: readonly ActorKind[];
  readonly actorUserId?: string;
  readonly subjectUserId?: string;
  readonly targetType?: AuditTargetType;
  readonly targetId?: string;
  readonly occurredFrom?: Date;
  readonly occurredTo?: Date;
}
