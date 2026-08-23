/**
 * Evenement de domaine. Persiste via l'Outbox dans la meme transaction que l'agregat qui
 * l'emet (D9, docs/architecture/01-target-architecture.md §9.3) puis relaye par un worker
 * BullMQ. Tout consommateur doit etre idempotent : la garantie est at-least-once.
 */
export interface DomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly occurredAt: Date;
  readonly tenantId: string | null;
  readonly aggregateId: string;
}
