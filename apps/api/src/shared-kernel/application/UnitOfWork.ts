/**
 * Port d'unite de travail : englobe la transaction PostgreSQL et la publication Outbox
 * dans la meme transaction (D9). Les implementations infrastructure/ portent le detail
 * (client PG, `SET LOCAL app.tenant_id` pour le RLS — ADR-0001 couche 4).
 */
export interface UnitOfWork {
  withTransaction<T>(work: () => Promise<T>): Promise<T>;
}
