import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Le port `UnitOfWork` (shared-kernel/application/UnitOfWork.ts) expose deliberement
 * `work: () => Promise<T>` sans passer le client transactionnel — les repositories ne doivent
 * pas dependre d'un parametre de transaction explicite dans leur signature de port (ce serait
 * une fuite d'infrastructure dans le domaine/l'application). La transaction Prisma active est
 * donc propagee implicitement via `AsyncLocalStorage`, le temps de l'execution de `work`.
 */
export type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

const storage = new AsyncLocalStorage<Prisma.TransactionClient>();

export function runWithPrismaTransaction<T>(
  tx: Prisma.TransactionClient,
  work: () => Promise<T>,
): Promise<T> {
  return storage.run(tx, work);
}

/** A appeler par chaque repository avant toute requete : renvoie le client transactionnel actif si present, sinon le client de base. */
export function resolvePrismaClient(base: PrismaClient): PrismaClientOrTx {
  return storage.getStore() ?? base;
}
