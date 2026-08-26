import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis quand l'INTEGRALITE du jeu de codes de recuperation est remplacee (jamais un ajout
 * partiel — ADR-0005 §3). Ne porte aucun code, ni en clair ni son condensat (ADR-0005 §6).
 */
export class MfaRecoveryCodesRegenerated implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.mfa-enrollment.recovery-codes-regenerated';
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
  }): MfaRecoveryCodesRegenerated {
    return new MfaRecoveryCodesRegenerated({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.enrollmentId,
      userAccountId: params.userAccountId,
    });
  }
}
