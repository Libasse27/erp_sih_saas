import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventHandler } from '../../../shared-kernel/application/OutboxEventHandler.js';
import { PgUnitOfWork } from '../../../shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { CompleteProvisioningHandler } from '../application/commands/CompleteProvisioning.js';
import { CreateHealthFacilityHandler } from '../application/commands/CreateHealthFacility.js';
import { SeedFacilityConfigurationHandler } from '../application/commands/SeedFacilityConfiguration.js';
import { createCompleteProvisioningOnFacilityConfigurationSeededHandler } from '../application/services/CompleteProvisioningOnFacilityConfigurationSeeded.js';
import { createSeedFacilityConfigurationOnMembershipGrantedHandler } from '../application/services/SeedFacilityConfigurationOnMembershipGranted.js';
import type { UserAccountExistenceChecker } from '../application/ports/UserAccountExistenceChecker.js';
import type { FacilitySettingsRepository } from '../domain/ports/FacilitySettingsRepository.js';
import type { HealthFacilityRepository } from '../domain/ports/HealthFacilityRepository.js';
import { PrismaFacilitySettingsRepository } from './persistence/PrismaFacilitySettingsRepository.js';
import { PrismaHealthFacilityRepository } from './persistence/PrismaHealthFacilityRepository.js';

export interface TenantModule {
  readonly repositories: {
    readonly healthFacilities: HealthFacilityRepository;
    readonly facilitySettings: FacilitySettingsRepository;
  };
  readonly unitOfWork: UnitOfWork;
  readonly handlers: {
    readonly createHealthFacility: CreateHealthFacilityHandler;
    readonly seedFacilityConfiguration: SeedFacilityConfigurationHandler;
    readonly completeProvisioning: CompleteProvisioningHandler;
  };
  /** Consommateurs Outbox exposes par ce module — cables UNIQUEMENT dans composition-root.ts. */
  readonly outboxHandlers: {
    /** Troisieme etape chorographiee de la Saga de provisioning (ADR-0008 §1/§4/§10, etape 10/13) — consomme `identity.membership.granted`. */
    readonly seedFacilityConfigurationOnMembershipGranted: OutboxEventHandler;
    /** Derniere etape chorographiee de la Saga de provisioning (ADR-0008 §1/§4/§11, etape 10/13) — consomme `tenant.facility-configuration-seeded` (propre evenement de ce module). */
    readonly completeProvisioningOnFacilityConfigurationSeeded: OutboxEventHandler;
  };
}

/**
 * Cablage du module Tenant (Phase 0, etape 3/13 ; etendu ADR-0008, etape 10/13).
 *
 * Instancie son propre `PgUnitOfWork` plutot que de recevoir celui d'Identity en dependance :
 * `PgUnitOfWork` (shared-kernel/infrastructure/) est un adaptateur sans etat propre au-dela de
 * la reference au `PrismaClient` qu'on lui passe — deux instances qui enveloppent le MEME
 * `PrismaClient` sont strictement equivalentes (le mecanisme `SET LOCAL` / AsyncLocalStorage
 * qu'elles delegent a `PrismaTransactionContext.ts` est, lui, un singleton de module partage).
 * Ce choix evite un couplage de construction entre modules (Tenant n'a pas besoin qu'Identity
 * soit construit avant lui, ni l'inverse) sans dupliquer la logique RLS elle-meme, qui reste
 * definie une seule fois dans shared-kernel/.
 *
 * `userAccountExistenceChecker` (ADR-0008 §9, amendement 1) : port cross-module OBLIGATOIRE
 * depuis cette etape — l'implementation reelle (qui delegue au `UserAccountRepository` du module
 * Identity) est fournie par l'appelant (composition-root.ts), jamais construite ici (meme
 * raisonnement que `tenantAccessChecker` cote Identity, en sens inverse).
 */
export function buildTenantModule(deps: {
  prisma: PrismaClient;
  clock: Clock;
  idGenerator: IdGenerator;
  userAccountExistenceChecker: UserAccountExistenceChecker;
}): TenantModule {
  const healthFacilities = new PrismaHealthFacilityRepository(deps.prisma);
  const facilitySettings = new PrismaFacilitySettingsRepository(deps.prisma);
  const unitOfWork = new PgUnitOfWork(deps.prisma);

  const seedFacilityConfiguration = new SeedFacilityConfigurationHandler(
    facilitySettings,
    unitOfWork,
    deps.clock,
    deps.idGenerator,
  );
  const completeProvisioning = new CompleteProvisioningHandler(
    facilitySettings,
    unitOfWork,
    deps.clock,
    deps.idGenerator,
  );

  return {
    repositories: { healthFacilities, facilitySettings },
    unitOfWork,
    handlers: {
      createHealthFacility: new CreateHealthFacilityHandler(
        healthFacilities,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
        deps.userAccountExistenceChecker,
      ),
      seedFacilityConfiguration,
      completeProvisioning,
    },
    outboxHandlers: {
      seedFacilityConfigurationOnMembershipGranted: createSeedFacilityConfigurationOnMembershipGrantedHandler({
        seedFacilityConfigurationHandler: seedFacilityConfiguration,
      }),
      completeProvisioningOnFacilityConfigurationSeeded: createCompleteProvisioningOnFacilityConfigurationSeededHandler({
        completeProvisioningHandler: completeProvisioning,
      }),
    },
  };
}
