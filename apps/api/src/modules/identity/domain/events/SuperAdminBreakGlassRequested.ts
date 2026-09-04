import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis a la creation d'une demande de recuperation break-glass `SUPER_ADMIN` (ADR-0005
 * Amendement 1, O-04 residu 4). Consomme par le module `notifications` (ACL, port
 * `RecipientDirectory.findActiveSuperAdminEmails`) pour alerter IMMEDIATEMENT les autres
 * `SUPER_ADMIN` actifs — jamais le motif en texte libre (meme discipline de minimisation
 * qu'ADR-0005 §6/`MfaReEnrollmentForced` : le motif reste dans `AuditEntry` uniquement).
 */
export class SuperAdminBreakGlassRequested implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.super-admin-break-glass.requested';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string | null = null;
  readonly aggregateId: string;
  readonly requestedByUserId: string;
  readonly subjectUserAccountId: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    requestedByUserId: string;
    subjectUserAccountId: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.requestedByUserId = params.requestedByUserId;
    this.subjectUserAccountId = params.subjectUserAccountId;
  }

  static create(params: {
    requestId: string;
    requestedByUserId: string;
    subjectUserAccountId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SuperAdminBreakGlassRequested {
    return new SuperAdminBreakGlassRequested({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.requestId,
      requestedByUserId: params.requestedByUserId,
      subjectUserAccountId: params.subjectUserAccountId,
    });
  }
}
