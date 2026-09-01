import type { AuditCategory } from './value-objects/AuditCategory.js';
import type { AuditEventType } from './value-objects/AuditEventType.js';
import type { AuditOutcome } from './value-objects/AuditOutcome.js';
import type { ActorKind } from './value-objects/ActorKind.js';
import type { AuditTargetType } from './value-objects/AuditTargetType.js';

/**
 * Charge d'entree du calcul canonique (ADR-0009 §5.2) — TOUS les champs metier de l'entree PLUS
 * son rattachement a la chaine (`chainKey`/`chainSequence`/`previousEntryHash`), a l'EXCLUSION de
 * `createdAt` (horodatage serveur technique, non porte par le domaine — un verificateur ne doit
 * jamais dependre d'une valeur que l'application ne controle pas).
 */
export interface AuditEntryCanonicalPayloadInput {
  readonly id: string;
  readonly chainKey: string;
  readonly chainSequence: number;
  readonly previousEntryHash: string | null;
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
  /**
   * Reference de session DERIVEE (`AuditEntry.sessionRef`, ADR-0009 §3.1) — jamais le `sessionId`
   * brut. ATTENTION, piege signale explicitement par l'ADR (§5.2) : ce champ est serialise sous
   * la cle JSON `"sessionId"` (voir `canonicalize()` ci-dessous), PAS `"sessionRef"`. Les noms de
   * cles de `canonicalJson` sont un CONTRAT FIGE par l'enveloppe `v1.` de `entry_hash`, jamais une
   * convention de nommage interne : les renommer changerait l'empreinte de TOUTES les entrees
   * deja chainees et les ferait apparaitre comme ALTEREES au verificateur — une fausse alerte
   * d'integrite. Ne JAMAIS "corriger" cette cle sans passer par un `v2` explicite.
   */
  readonly sessionRef: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
}

/** Serialise `Date` en ISO-8601 UTC A LA MILLISECONDE (ADR-0009 §5.2) — jamais tronque a la seconde. */
function toUtcMillisecondIso(date: Date): string {
  return date.toISOString();
}

/**
 * Serialiseur JSON canonique DETERMINISTE et RECURSIF : cles triees lexicographiquement a tous
 * les niveaux, `null` explicite (jamais une cle omise), sans espace, tableaux dans leur ordre
 * persiste. Fonction GENERIQUE (pas seulement les clefs de premier niveau) pour rester correcte
 * si la forme de la charge evolue un jour.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`AuditEntryCanonicalPayload : type non serialisable rencontre (${typeof value}).`);
}

/**
 * Fonction PURE du domaine (ADR-0009 §5.2) : contrat qui ne doit jamais deriver, testable sans
 * infrastructure. Ne fait AUCUN hachage — voir `ports/AuditEntryHasher.ts` (le "v1." + SHA-256 +
 * prefixe "audit-entry:v1|" est la responsabilite de l'implementation du port, jamais de cette
 * fonction).
 */
export function buildAuditEntryCanonicalPayload(input: AuditEntryCanonicalPayloadInput): string {
  return canonicalize({
    id: input.id,
    chainKey: input.chainKey,
    chainSequence: input.chainSequence,
    previousEntryHash: input.previousEntryHash,
    category: input.category,
    eventType: input.eventType,
    outcome: input.outcome,
    tenantId: input.tenantId,
    actorKind: input.actorKind,
    actorUserId: input.actorUserId,
    actorRoleCodes: [...input.actorRoleCodes],
    subjectUserId: input.subjectUserId,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    // Cle JSON DELIBEREMENT "sessionId" (jamais "sessionRef") — voir le commentaire de
    // `AuditEntryCanonicalPayloadInput.sessionRef` ci-dessus : renommer cette cle invaliderait
    // l'empreinte de toutes les entrees deja chainees (ADR-0009 §5.2).
    sessionId: input.sessionRef,
    correlationId: input.correlationId,
    occurredAt: toUtcMillisecondIso(input.occurredAt),
  });
}
