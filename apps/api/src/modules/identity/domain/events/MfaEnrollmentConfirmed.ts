import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis lors de la toute PREMIERE activation d'un facteur TOTP pour ce compte (jamais rejouee
 * pour un remplacement — voir `MfaFactorReplaced` pour ce cas). `tenantId` toujours `null`
 * (niveau plateforme). Ne porte ni le secret ni les codes de recuperation en clair (ADR-0005 §6).
 */
export class MfaEnrollmentConfirmed implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.mfa-enrollment.confirmed';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string | null = null;
  readonly aggregateId: string;
  readonly userAccountId: string;

  private constructor(params: { eventId: string; occurredAt: Date; aggregateId: string; userAccountId: string }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.userAccountId = params.userAccountId;
  }

  static create(params: {
    enrollmentId: string;
    userAccountId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): MfaEnrollmentConfirmed {
    return new MfaEnrollmentConfirmed({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.enrollmentId,
      userAccountId: params.userAccountId,
    });
  }
}
