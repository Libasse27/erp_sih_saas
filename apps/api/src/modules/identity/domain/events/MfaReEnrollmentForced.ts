import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis quand un administrateur force la reinitialisation du facteur d'un tiers
 * (`ForceMfaReEnrollment`). Porte `userAccountId` (le sujet) et `requestedByUserId` (l'acteur) —
 * **jamais le motif** : minimisation deliberee (ADR-0005 §6), le motif reste dans `AuditEntry`
 * uniquement, jamais dans un message Outbox qui pourrait porter des elements personnels en texte
 * libre.
 */
export class MfaReEnrollmentForced implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.mfa-enrollment.re-enrollment-forced';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string | null = null;
  readonly aggregateId: string;
  readonly userAccountId: string;
  readonly requestedByUserId: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    userAccountId: string;
    requestedByUserId: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.userAccountId = params.userAccountId;
    this.requestedByUserId = params.requestedByUserId;
  }

  static create(params: {
    enrollmentId: string;
    userAccountId: string;
    requestedByUserId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): MfaReEnrollmentForced {
    return new MfaReEnrollmentForced({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.enrollmentId,
      userAccountId: params.userAccountId,
      requestedByUserId: params.requestedByUserId,
    });
  }
}
