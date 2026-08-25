import type { Prisma } from '@prisma/client';
import type { PrismaClientOrTx } from './PrismaTransactionContext.js';
import type { DomainEvent } from '../../domain/DomainEvent.js';

/**
 * Ecrit les evenements de domaine accumules par un agregat dans la table Outbox
 * (`platform.OutboxMessage`), DANS LA TRANSACTION COURANTE (D9, 01-target-architecture.md §9.3 :
 * "l'evenement est persiste dans la meme transaction que l'agregat"). A appeler par chaque
 * repository Prisma juste apres avoir persiste l'agregat lui-meme, avec le MEME client
 * transactionnel (`resolvePrismaClient(this.prisma)`), jamais un client separe — c'est cette
 * identite de transaction qui garantit qu'un evenement n'est jamais publie pour un agregat dont
 * l'ecriture a echoue (rollback), et reciproquement.
 *
 * Vit dans shared-kernel/infrastructure/ : point d'implementation UNIQUE, reutilise par tous les
 * modules (meme raisonnement que `PrismaTransactionContext.ts` / `PgUnitOfWork.ts`) — jamais une
 * serialisation d'evenement dupliquee par module.
 *
 * Le payload JSON est une copie structurelle de l'evenement (`JSON.parse(JSON.stringify(...))`) :
 * les implementations de `DomainEvent` de ce depot n'exposent que des champs deja serialisables
 * (string, number, boolean, null, Date convertie en ISO string par l'evenement lui-meme — voir
 * SubscriptionStarted.ts) ; aucune methode, aucune reference circulaire. Le nom de la table
 * Outbox (`platform.OutboxMessage`) vit dans le schema `platform`, HORS RLS (ADR-0001 §3.3) :
 * necessaire pour que le relais (OutboxRelay.ts), processus de niveau plateforme, puisse lire les
 * messages de TOUS les tenants sans contournement de securite — voir le commentaire de tete de
 * migration correspondante pour la justification complete.
 */
export async function writeDomainEventsToOutbox(
  client: PrismaClientOrTx,
  events: readonly DomainEvent[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  await client.outboxMessage.createMany({
    data: events.map((event) => ({
      id: event.eventId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      aggregateId: event.aggregateId,
      tenantId: event.tenantId,
      occurredAt: event.occurredAt,
      payload: toJsonPayload(event),
      status: 'PENDING' as const,
    })),
  });
}

function toJsonPayload(event: DomainEvent): Prisma.InputJsonValue {
  // Copie structurelle explicite : evite de deverser un prototype de classe (methodes, symboles)
  // dans une colonne JSONB. Chaque implementation de DomainEvent de ce depot n'expose que des
  // champs deja JSON-safe (voir commentaire de tete de fichier).
  return JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
}
