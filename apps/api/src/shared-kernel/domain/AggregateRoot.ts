import type { DomainEvent } from './DomainEvent.js';
import { Entity } from './Entity.js';

/**
 * Racine d'agregat : seul point d'entree pour muter le graphe d'objets qu'elle protege.
 * Accumule les evenements de domaine a publier via l'Outbox (D9) au moment du commit —
 * elle ne les publie jamais elle-meme, ce n'est pas son role.
 */
export abstract class AggregateRoot<
  Id extends { equals(other: Id): boolean },
> extends Entity<Id> {
  private readonly _domainEvents: DomainEvent[] = [];

  protected addDomainEvent(event: DomainEvent): void {
    this._domainEvents.push(event);
  }

  pullDomainEvents(): readonly DomainEvent[] {
    const events = [...this._domainEvents];
    this._domainEvents.length = 0;
    return events;
  }
}
