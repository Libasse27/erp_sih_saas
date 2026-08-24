import type { PrismaClient } from '@prisma/client';
import type { UnitOfWork, UnitOfWorkContext } from '../../application/UnitOfWork.js';
import { runWithPrismaTransaction } from './PrismaTransactionContext.js';

/**
 * Implementation PostgreSQL du UnitOfWork (D9, ADR-0001 couche 4). Positionne
 * `app.tenant_id` / `app.user_id` via `select set_config(...)` (jamais par interpolation de
 * chaine — protection injection) avant d'executer `work`, puis rend la transaction Prisma
 * disponible aux repositories via `PrismaTransactionContext` (AsyncLocalStorage).
 *
 * Vit dans shared-kernel/infrastructure/ (et non plus dans modules/identity/) depuis l'ajout du
 * module Tenant (Phase 0, etape 3) : deja concue comme generique a l'etape Identity (voir
 * commentaire sur `UnitOfWorkContext`), cette classe est desormais instanciee une seule fois par
 * le composition-root et partagee par tous les modules Prisma — un seul point qui positionne
 * `SET LOCAL`, jamais une implementation dupliquee par module.
 */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaClient) {}

  async withTransaction<T>(work: () => Promise<T>, context?: UnitOfWorkContext): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      if (context?.tenantId !== undefined) {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${context.tenantId.toString()}, true)`;
      }
      if (context?.actorUserId !== undefined) {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${context.actorUserId}, true)`;
      }
      return runWithPrismaTransaction(tx, work);
    });
  }
}
