import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis a la creation d'une identite globale (`UserAccount`). Niveau plateforme : `tenantId`
 * est toujours `null`, un `UserAccount` n'appartenant structurellement a aucun tenant (voir
 * UserAccount.ts).
 */
export class UserAccountCreated implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.user-account.created';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string | null = null;
  readonly aggregateId: string;
  readonly email: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    email: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.email = params.email;
  }

  static create(params: {
    userAccountId: string;
    email: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): UserAccountCreated {
    return new UserAccountCreated({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.userAccountId,
      email: params.email,
    });
  }
}
