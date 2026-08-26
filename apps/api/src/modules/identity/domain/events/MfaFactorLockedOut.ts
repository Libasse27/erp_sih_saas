import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis quand le seuil d'echecs consecutifs (`MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS`, voir
 * `MfaTuning.ts`) est atteint et que le facteur est temporairement verrouille. Point d'extension
 * futur : alerte de securite au titulaire du compte — aucun consommateur implemente a ce stade.
 */
export class MfaFactorLockedOut implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.mfa-enrollment.factor-locked-out';
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
  }): MfaFactorLockedOut {
    return new MfaFactorLockedOut({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.enrollmentId,
      userAccountId: params.userAccountId,
    });
  }
}
