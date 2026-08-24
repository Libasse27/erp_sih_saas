import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../shared-kernel/application/UnitOfWork.js';
import { PgUnitOfWork } from '../../../shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { CreateHealthFacilityHandler } from '../application/commands/CreateHealthFacility.js';
import type { HealthFacilityRepository } from '../domain/ports/HealthFacilityRepository.js';
import { PrismaHealthFacilityRepository } from './persistence/PrismaHealthFacilityRepository.js';

export interface TenantModule {
  readonly repositories: {
    readonly healthFacilities: HealthFacilityRepository;
  };
  readonly unitOfWork: UnitOfWork;
  readonly handlers: {
    readonly createHealthFacility: CreateHealthFacilityHandler;
  };
}

/**
 * Cablage du module Tenant (Phase 0, etape 3/13).
 *
 * Instancie son propre `PgUnitOfWork` plutot que de recevoir celui d'Identity en dependance :
 * `PgUnitOfWork` (shared-kernel/infrastructure/) est un adaptateur sans etat propre au-dela de
 * la reference au `PrismaClient` qu'on lui passe — deux instances qui enveloppent le MEME
 * `PrismaClient` sont strictement equivalentes (le mecanisme `SET LOCAL` / AsyncLocalStorage
 * qu'elles delegent a `PrismaTransactionContext.ts` est, lui, un singleton de module partage).
 * Ce choix evite un couplage de construction entre modules (Tenant n'a pas besoin qu'Identity
 * soit construit avant lui, ni l'inverse) sans dupliquer la logique RLS elle-meme, qui reste
 * definie une seule fois dans shared-kernel/.
 */
export function buildTenantModule(deps: {
  prisma: PrismaClient;
  clock: Clock;
  idGenerator: IdGenerator;
}): TenantModule {
  const healthFacilities = new PrismaHealthFacilityRepository(deps.prisma);
  const unitOfWork = new PgUnitOfWork(deps.prisma);

  return {
    repositories: { healthFacilities },
    unitOfWork,
    handlers: {
      createHealthFacility: new CreateHealthFacilityHandler(
        healthFacilities,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
    },
  };
}
