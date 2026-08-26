import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis a la creation d'une identite globale (`UserAccount`). Niveau plateforme : `tenantId`
 * est toujours `null`, un `UserAccount` n'appartenant structurellement a aucun tenant (voir
 * UserAccount.ts).
 *
 * NE PORTE PAS `email` (retire a la revue de securite de l'etape 6/13, D9) : cet evenement est
 * desormais REELLEMENT relaye via l'Outbox (PrismaUserAccountRepository.save()) sans qu'AUCUN
 * consommateur n'existe encore (voir docs/domain/events.md) — persister une donnee personnelle
 * (email) dans `platform.OutboxMessage` sans besoin fonctionnel identifie violerait la regle de
 * minimisation (§10 du system prompt : "aucun log/registre de donnee personnelle... sans
 * necessite"). `aggregateId` (le `UserAccountId`) suffit a tout futur consommateur pour retrouver
 * le compte via `UserAccountRepository.findById()` s'il a besoin de son email.
 */
export class UserAccountCreated implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.user-account.created';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string | null = null;
  readonly aggregateId: string;

  private constructor(params: { eventId: string; occurredAt: Date; aggregateId: string }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
  }

  static create(params: { userAccountId: string; clock: Clock; idGenerator: IdGenerator }): UserAccountCreated {
    return new UserAccountCreated({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.userAccountId,
    });
  }
}
