import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis quand une confirmation active un NOUVEAU facteur alors que ce compte en avait deja
 * possede un par le passe (ré-enrolement apres `RESET_REQUIRED`) — distinct de
 * `MfaEnrollmentConfirmed` (premiere activation jamais vue). `tenantId` toujours `null`.
 */
export class MfaFactorReplaced implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.mfa-enrollment.factor-replaced';
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
  }): MfaFactorReplaced {
    return new MfaFactorReplaced({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.enrollmentId,
      userAccountId: params.userAccountId,
    });
  }
}
