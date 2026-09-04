import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import { AuditEntryId } from './value-objects/AuditEntryId.js';
import type { AuditCategory } from './value-objects/AuditCategory.js';
import type { AuditEventType } from './value-objects/AuditEventType.js';
import type { AuditOutcome } from './value-objects/AuditOutcome.js';
import type { ActorKind } from './value-objects/ActorKind.js';
import type { AuditTargetType } from './value-objects/AuditTargetType.js';
import { AuditChainKey } from './value-objects/AuditChainKey.js';
import type { AuditSessionReferenceDeriver } from './ports/AuditSessionReferenceDeriver.js';

interface AuditEntryProps {
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
   * Reference DERIVEE non reversible de la session (ADR-0009 §3.1, correctif securite
   * 2026-09-01) — JAMAIS le `sessionId` (jeton de session vivant, rejouable en
   * `Authorization: Bearer`). Calculee UNIQUEMENT dans `record()` ci-dessous, voir ce
   * commentaire de fabrique.
   */
  readonly sessionRef: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
  /**
   * Position et empreintes de chaine (ADR-0009 §5) — TOUJOURS `null` sur une entree fraichement
   * `record()`ee (ces valeurs ne sont determinables qu'au moment de l'INSERT, sous verrou
   * consultatif, voir `PrismaAuditEntryRepository.append()`) ; renseignees UNIQUEMENT sur une
   * entree `reconstitute()`e depuis une ligne deja persistee.
   */
  readonly chainSequence: number | null;
  readonly previousEntryHash: string | null;
  readonly entryHash: string | null;
}

/**
 * Preuve APPEND-ONLY d'une action sensible du SaaS Core (ADR-0005 §5, O-04.7 ; etendue ADR-0009).
 * N'etend `AggregateRoot` QUE pour l'identite/egalite qu'il fournit (`Entity`) — cette classe
 * N'EMET ET N'EMETTRA JAMAIS de `DomainEvent` : ce n'est pas un evenement d'INTEGRATION
 * (asynchrone, at-least-once), c'est DIRECTEMENT la preuve persistee, ecrite dans la transaction
 * de l'action auditee (voir `PrismaAuditEntryRepository.append()`, jamais via l'Outbox —
 * ADR-0005 §5, raisons 1-3 ; ADR-0009 §4).
 *
 * Refuse (leve, PAS un `Result.failure` : c'est un bug de l'appelant, pas un echec metier
 * attendu) l'absence de motif quand `eventType` vaut `MFA_RE_ENROLLMENT_FORCED` OU
 * `SUPER_ADMIN_BREAK_GLASS_REQUESTED` ET `outcome === 'SUCCESS'` — le second ajoute par ADR-0005
 * Amendement 1, meme discipline que le premier (ADR-0005 §6/§Contexte).
 *
 * ADR-0009 §3 — DEUX invariants supplementaires, VERIFIES ICI EN PLUS de la contrainte `CHECK`
 * en base (doctrine des deux defenses independantes, jamais une seule) :
 *   - `actorKind === 'SYSTEM'` <=> `actorUserId === null` (jamais de sentinelle, un discriminant
 *     EXPLICITE — alternative ecartee #7 de l'ADR) ;
 *   - `targetType === 'USER_ACCOUNT'` => `subjectUserId !== null`.
 * Une violation ici est TOUJOURS un bug appelant (l'adaptateur cross-module qui construit les
 * parametres a mal derive `actorKind`/`targetType`), jamais un echec metier attendu — leve, pas
 * `Result.failure`.
 */
export class AuditEntry extends AggregateRoot<AuditEntryId> {
  private readonly props: AuditEntryProps;

  private constructor(id: AuditEntryId, props: AuditEntryProps) {
    super(id);
    this.props = props;
  }

  /**
   * SEULE fabrique de l'agregat, SEUL point de derivation de `sessionRef` (ADR-0009 §3.1,
   * correctif securite 2026-09-01). `params.sessionId` reste nomme ainsi car c'est bien un
   * `sessionId` BRUT a cet instant (le paramètre d'entree, toujours passe tel quel par les 5
   * producteurs — `identity`/`subscription`/`tenant`/`payment`/le controleur HTTP, AUCUN d'entre
   * eux ne derive lui-meme) ; c'est le CHAMP RESULTANT, conserve dans `props.sessionRef`, qui rend
   * la transformation visible a la lecture. `reconstitute()` ci-dessous ne derive JAMAIS rien : il
   * recoit `sessionRef` deja calcule, tel que persiste.
   */
  static record(params: {
    category: AuditCategory;
    eventType: AuditEventType;
    outcome: AuditOutcome;
    tenantId: string | null;
    actorKind: ActorKind;
    actorUserId: string | null;
    actorRoleCodes: readonly string[];
    subjectUserId: string | null;
    targetType: AuditTargetType;
    targetId: string | null;
    reason: string | null;
    sessionId: string | null;
    correlationId: string | null;
    clock: Clock;
    idGenerator: IdGenerator;
    sessionReferenceDeriver: AuditSessionReferenceDeriver;
  }): AuditEntry {
    if (
      (params.eventType === 'MFA_RE_ENROLLMENT_FORCED' || params.eventType === 'SUPER_ADMIN_BREAK_GLASS_REQUESTED') &&
      params.outcome === 'SUCCESS' &&
      (params.reason === null || params.reason.trim().length === 0)
    ) {
      throw new Error(
        `AuditEntry.record : motif obligatoire pour un ${params.eventType} en SUCCESS (bug appelant, pas un echec metier attendu).`,
      );
    }
    if (params.actorKind === 'SYSTEM' && params.actorUserId !== null) {
      throw new Error(
        'AuditEntry.record : actorUserId doit etre null quand actorKind === "SYSTEM" (bug appelant, invariant §3 ADR-0009).',
      );
    }
    if (params.actorKind !== 'SYSTEM' && params.actorUserId === null) {
      throw new Error(
        'AuditEntry.record : actorUserId est obligatoire quand actorKind !== "SYSTEM" (bug appelant, invariant §3 ADR-0009).',
      );
    }
    if (params.targetType === 'USER_ACCOUNT' && params.subjectUserId === null) {
      throw new Error(
        'AuditEntry.record : subjectUserId est obligatoire quand targetType === "USER_ACCOUNT" (bug appelant, invariant §3 ADR-0009).',
      );
    }
    const idResult = AuditEntryId.create(params.idGenerator.generate());
    if (idResult.isFailure()) {
      throw new Error('IdGenerator a produit un identifiant invalide pour AuditEntry.');
    }
    return new AuditEntry(idResult.getValue(), {
      category: params.category,
      eventType: params.eventType,
      outcome: params.outcome,
      tenantId: params.tenantId,
      actorKind: params.actorKind,
      actorUserId: params.actorUserId,
      actorRoleCodes: params.actorRoleCodes,
      subjectUserId: params.subjectUserId,
      targetType: params.targetType,
      targetId: params.targetId,
      reason: params.reason,
      sessionRef: params.sessionReferenceDeriver.derive(params.sessionId),
      correlationId: params.correlationId,
      occurredAt: params.clock.now(),
      chainSequence: null,
      previousEntryHash: null,
      entryHash: null,
    });
  }

  /** Reconstruction depuis la persistance (`findById`/`listFor*`/`readChainSegment`) — porte les champs de chaine tels que persistes. */
  static reconstitute(id: AuditEntryId, props: AuditEntryProps): AuditEntry {
    return new AuditEntry(id, props);
  }

  get category(): AuditCategory {
    return this.props.category;
  }

  get eventType(): AuditEventType {
    return this.props.eventType;
  }

  get outcome(): AuditOutcome {
    return this.props.outcome;
  }

  get tenantId(): string | null {
    return this.props.tenantId;
  }

  get actorKind(): ActorKind {
    return this.props.actorKind;
  }

  get actorUserId(): string | null {
    return this.props.actorUserId;
  }

  get actorRoleCodes(): readonly string[] {
    return this.props.actorRoleCodes;
  }

  get subjectUserId(): string | null {
    return this.props.subjectUserId;
  }

  get targetType(): AuditTargetType {
    return this.props.targetType;
  }

  get targetId(): string | null {
    return this.props.targetId;
  }

  get reason(): string | null {
    return this.props.reason;
  }

  get sessionRef(): string | null {
    return this.props.sessionRef;
  }

  get correlationId(): string | null {
    return this.props.correlationId;
  }

  get occurredAt(): Date {
    return this.props.occurredAt;
  }

  /** Derive TOUJOURS depuis `tenantId` (colonne generee cote base, ADR-0009 §5.1) — jamais un champ stocke separement. */
  get chainKey(): AuditChainKey {
    return AuditChainKey.derive(this.props.tenantId);
  }

  get chainSequence(): number | null {
    return this.props.chainSequence;
  }

  get previousEntryHash(): string | null {
    return this.props.previousEntryHash;
  }

  get entryHash(): string | null {
    return this.props.entryHash;
  }
}
