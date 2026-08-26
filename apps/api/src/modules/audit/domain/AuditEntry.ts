import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import { AuditEntryId } from './value-objects/AuditEntryId.js';
import type { AuditCategory } from './value-objects/AuditCategory.js';
import type { AuditEventType } from './value-objects/AuditEventType.js';
import type { AuditOutcome } from './value-objects/AuditOutcome.js';

interface AuditEntryProps {
  readonly category: AuditCategory;
  readonly eventType: AuditEventType;
  readonly outcome: AuditOutcome;
  readonly tenantId: string | null;
  readonly subjectUserId: string;
  readonly actorUserId: string;
  readonly actorRoleCodes: readonly string[];
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
}

/**
 * Preuve APPEND-ONLY d'une action MFA (ADR-0005 §5, O-04.7). N'etend `AggregateRoot` QUE pour
 * l'identite/egalite qu'il fournit (`Entity`) — cette classe N'EMET ET N'EMETTRA JAMAIS de
 * `DomainEvent` : ce n'est pas un evenement d'INTEGRATION (asynchrone, at-least-once), c'est
 * DIRECTEMENT la preuve persistee, ecrite dans la transaction de l'action auditee (voir
 * `PrismaAuditEntryRepository.append()`, jamais via l'Outbox — ADR-0005 §5, raisons 1-3).
 *
 * Refuse (leve, PAS un `Result.failure` : c'est un bug de l'appelant, pas un echec metier
 * attendu) l'absence de motif quand `eventType === 'MFA_RE_ENROLLMENT_FORCED'` ET
 * `outcome === 'SUCCESS'` — le motif est OBLIGATOIRE pour la REUSSITE de cette action administree
 * (O-04, residu 3), et n'existe QUE dans cette entree d'audit (jamais dans le payload Outbox de
 * `MfaReEnrollmentForced`, voir ADR-0005 §6).
 *
 * Restriction a `outcome === 'SUCCESS'` (correctif securite, revue independante F-4) : un REFUS
 * (`DENIED`, ex. acteur sans permission `mfa:reset`, sans step-up, ou sujet hors du tenant de
 * l'acteur) doit lui aussi produire une preuve d'audit — l'invariant ne peut donc pas exiger un
 * motif metier non vide pour un chemin ou l'appelant n'en a justement pas encore recueilli un
 * (le motif n'est demande qu'APRES verification de l'habilitation, voir `ForceMfaReEnrollment.ts`).
 * Exiger un motif pour un refus aurait forme un `null`/vide silencieusement rejete par cet
 * invariant, empechant precisement la tracabilite que l'audit doit garantir pour une tentative de
 * contournement.
 */
export class AuditEntry extends AggregateRoot<AuditEntryId> {
  private readonly props: AuditEntryProps;

  private constructor(id: AuditEntryId, props: AuditEntryProps) {
    super(id);
    this.props = props;
  }

  static record(params: {
    category: AuditCategory;
    eventType: AuditEventType;
    outcome: AuditOutcome;
    tenantId: string | null;
    subjectUserId: string;
    actorUserId: string;
    actorRoleCodes: readonly string[];
    reason: string | null;
    sessionId: string | null;
    correlationId: string | null;
    clock: Clock;
    idGenerator: IdGenerator;
  }): AuditEntry {
    if (
      params.eventType === 'MFA_RE_ENROLLMENT_FORCED' &&
      params.outcome === 'SUCCESS' &&
      (params.reason === null || params.reason.trim().length === 0)
    ) {
      throw new Error(
        'AuditEntry.record : motif obligatoire pour un MFA_RE_ENROLLMENT_FORCED en SUCCESS (bug appelant, pas un echec metier attendu).',
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
      subjectUserId: params.subjectUserId,
      actorUserId: params.actorUserId,
      actorRoleCodes: params.actorRoleCodes,
      reason: params.reason,
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      occurredAt: params.clock.now(),
    });
  }

  /** Reconstruction depuis la persistance (`findById`). */
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

  get subjectUserId(): string {
    return this.props.subjectUserId;
  }

  get actorUserId(): string {
    return this.props.actorUserId;
  }

  get actorRoleCodes(): readonly string[] {
    return this.props.actorRoleCodes;
  }

  get reason(): string | null {
    return this.props.reason;
  }

  get sessionId(): string | null {
    return this.props.sessionId;
  }

  get correlationId(): string | null {
    return this.props.correlationId;
  }

  get occurredAt(): Date {
    return this.props.occurredAt;
  }
}
