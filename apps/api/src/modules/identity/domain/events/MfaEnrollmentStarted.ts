import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis quand un facteur TOTP est provisionne (premier enrolement OU redemarrage apres
 * `RESET_REQUIRED`), avant toute confirmation. Niveau plateforme : `tenantId` toujours `null`
 * (voir MfaEnrollment.ts). Ne porte JAMAIS le secret, ni en clair ni chiffre (ADR-0005 §6).
 */
export class MfaEnrollmentStarted implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.mfa-enrollment.started';
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
  }): MfaEnrollmentStarted {
    return new MfaEnrollmentStarted({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.enrollmentId,
      userAccountId: params.userAccountId,
    });
  }
}
