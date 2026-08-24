import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { Clock } from './shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from './shared-kernel/domain/ports/IdGenerator.js';
import type { TenantId } from './shared-kernel/domain/value-objects/TenantId.js';
import { SystemClock } from './shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from './shared-kernel/infrastructure/UuidGenerator.js';
import { loadEnv, type Env } from './config/env.js';
import { buildIdentityModule, type IdentityModule } from './modules/identity/infrastructure/IdentityModule.js';
import type {
  TenantAccessChecker,
  TenantAccessStatus,
} from './modules/identity/application/ports/TenantAccessChecker.js';
import { buildTenantModule, type TenantModule } from './modules/tenant/infrastructure/TenantModule.js';
import {
  buildSubscriptionModule,
  type SubscriptionModule,
} from './modules/subscription/infrastructure/SubscriptionModule.js';

/**
 * Adaptateur cross-module implementant le port `TenantAccessChecker` d'Identity en s'appuyant
 * sur le `HealthFacilityRepository` de Tenant. Vit ICI et nulle part ailleurs : c'est le seul
 * point du code autorise a connaitre les deux modules a la fois (01-target-architecture.md §5
 * — "un module n'importe jamais le domain/ d'un autre module ; les echanges passent par des
 * evenements ou des ports explicites"). Ni Identity ni Tenant n'importent l'un le domain/ de
 * l'autre : Identity ne connait que son propre port, Tenant ne connait meme pas l'existence
 * d'Identity. C'est ICI, et nulle part ailleurs, que le statut `FacilityStatus` du domain
 * Tenant (`ACTIVE`/`SUSPENDED`) est traduit vers le vocabulaire propre a Identity
 * (`TenantAccessStatus`) — la seule methode autorisee a lire `HealthFacility.isActive()`.
 */
class TenantModuleBackedAccessChecker implements TenantAccessChecker {
  constructor(private readonly tenant: TenantModule) {}

  async checkAccess(tenantId: TenantId): Promise<TenantAccessStatus> {
    const facility = await this.tenant.repositories.healthFacilities.findByTenantId(tenantId);
    if (facility === null) {
      return 'NOT_FOUND';
    }
    return facility.isActive() ? 'ACCESSIBLE' : 'SUSPENDED';
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
  readonly subscription: SubscriptionModule;
  /** Ferme proprement les connexions (SIGTERM) — appele une seule fois, jamais depuis un handler. */
  shutdown(): Promise<void>;
}

export function buildCompositionRoot(source: NodeJS.ProcessEnv = process.env): CompositionRoot {
  const env = loadEnv(source);
  const clock = new SystemClock();
  const idGenerator = new UuidGenerator();
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });

  // Tenant cable avant Identity : Identity depend du port `TenantAccessChecker`
  // (ResolveTenantContextHandler, Phase 0 etape 3), dont l'implementation ci-dessus a besoin du
  // module Tenant deja construit. L'inverse n'est jamais vrai : Tenant ne depend de rien
  // d'Identity.
  const tenant = buildTenantModule({ prisma, clock, idGenerator });
  const tenantAccessChecker = new TenantModuleBackedAccessChecker(tenant);
  const identity = buildIdentityModule({ prisma, redis, clock, idGenerator, tenantAccessChecker });
  // Subscription (Phase 0, etape 4/13) ne depend d'aucun autre module a ce stade — voir le
  // residu documente dans SubscriptionModule.ts sur l'absence volontaire d'un port
  // TenantAccessChecker cote Subscription (hors perimetre de cette etape).
  const subscription = buildSubscriptionModule({ prisma, clock, idGenerator });

  return {
    env,
    clock,
    idGenerator,
    prisma,
    redis,
    tenant,
    identity,
    subscription,
    async shutdown(): Promise<void> {
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}
