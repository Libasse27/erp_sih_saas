import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis lorsque le DERNIER code de recuperation disponible vient d'etre consomme (aucun code
 * n'est renouvele partiellement — ADR-0005 §3). Point d'extension futur : notification incitant
 * l'utilisateur a regenerer un nouveau jeu (`RegenerateMfaRecoveryCodes`) — aucun consommateur
 * implemente a ce stade.
 */
export class MfaRecoveryCodesExhausted implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.mfa-enrollment.recovery-codes-exhausted';
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
  }): MfaRecoveryCodesExhausted {
    return new MfaRecoveryCodesExhausted({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.enrollmentId,
      userAccountId: params.userAccountId,
    });
  }
}
