import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { Clock } from './shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from './shared-kernel/domain/ports/IdGenerator.js';
import type { TenantId } from './shared-kernel/domain/value-objects/TenantId.js';
import { SystemClock } from './shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from './shared-kernel/infrastructure/UuidGenerator.js';
import { loadEnv, type Env } from './config/env.js';
import { buildIdentityModule, type IdentityModule } from './modules/identity/infrastructure/IdentityModule.js';
import type { TenantExistenceChecker } from './modules/identity/application/ports/TenantExistenceChecker.js';
import { buildTenantModule, type TenantModule } from './modules/tenant/infrastructure/TenantModule.js';

/**
 * Adaptateur cross-module implementant le port `TenantExistenceChecker` d'Identity en
 * s'appuyant sur le `HealthFacilityRepository` de Tenant. Vit ICI et nulle part ailleurs :
 * c'est le seul point du code autorise a connaitre les deux modules a la fois
 * (01-target-architecture.md §5 — "un module n'importe jamais le domain/ d'un autre module ;
 * les echanges passent par des evenements ou des ports explicites"). Ni Identity ni Tenant
 * n'importent l'un le domain/ de l'autre : Identity ne connait que son propre port, Tenant ne
 * connait meme pas l'existence d'Identity.
 */
class TenantModuleBackedExistenceChecker implements TenantExistenceChecker {
  constructor(private readonly tenant: TenantModule) {}

  async exists(tenantId: TenantId): Promise<boolean> {
    return this.tenant.repositories.healthFacilities.existsByTenantId(tenantId);
  }
}

/**
 * Point de cablage unique des dependances (D3, 01-target-architecture.md §5).
 * Aucun singleton global : chaque entree fait partie de ce conteneur explicite, injecte
 * dans les handlers via le composition root de chaque module au fur et a mesure de leur
 * ajout (Identity, Tenant, Plan/Subscription... — Phase 0, etapes 2+).
 */
export interface CompositionRoot {
  readonly env: Env;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly tenant: TenantModule;
  readonly identity: IdentityModule;
  /** Ferme proprement les connexions (SIGTERM) — appele une seule fois, jamais depuis un handler. */
  shutdown(): Promise<void>;
}

export function buildCompositionRoot(source: NodeJS.ProcessEnv = process.env): CompositionRoot {
  const env = loadEnv(source);
  const clock = new SystemClock();
  const idGenerator = new UuidGenerator();
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });

  // Tenant cable avant Identity : Identity depend du port `TenantExistenceChecker`
  // (ResolveTenantContextHandler, Phase 0 etape 3), dont l'implementation ci-dessus a besoin du
  // module Tenant deja construit. L'inverse n'est jamais vrai : Tenant ne depend de rien
  // d'Identity.
  const tenant = buildTenantModule({ prisma, clock, idGenerator });
  const tenantExistenceChecker = new TenantModuleBackedExistenceChecker(tenant);
  const identity = buildIdentityModule({ prisma, redis, clock, idGenerator, tenantExistenceChecker });

  return {
    env,
    clock,
    idGenerator,
    prisma,
    redis,
    tenant,
    identity,
    async shutdown(): Promise<void> {
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}
