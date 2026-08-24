import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { buildIdentityModule, type IdentityModule } from '../../../src/modules/identity/infrastructure/IdentityModule.js';
import type { TenantExistenceChecker } from '../../../src/modules/identity/application/ports/TenantExistenceChecker.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import type { TenantSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { buildTenantModule, type TenantModule } from '../../../src/modules/tenant/infrastructure/TenantModule.js';
import { createTestPrismaClient, createTestRedisClient, uniqueEmail, uniqueFacilityName } from '../../identity/integration/dbTestHelpers.js';

/**
 * Preuve bout en bout du "contexte serveur" (Phase 0, etape 3, point 4) : depuis un `sessionId`
 * opaque jusqu'a une requete tenant-scoped reellement executee sous RLS Postgres — sans jamais
 * qu'un `tenantId` transite explicitement depuis un appelant exterieur. Aucune route HTTP n'est
 * necessaire pour prouver cette chaine (voir consigne : "pas une facade HTTP complete") ; ce
 * test appelle directement `ServerContextResolver` comme le ferait un futur middleware Express.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('Contexte serveur — de sessionId a une requete RLS-scopee reelle (Identity + Tenant)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let identity: IdentityModule;
  let tenant: TenantModule;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    redis = createTestRedisClient();
    tenant = buildTenantModule({ prisma, clock: new SystemClock(), idGenerator: new UuidGenerator() });
    const tenantExistenceChecker: TenantExistenceChecker = {
      exists: (tenantId) => tenant.repositories.healthFacilities.existsByTenantId(tenantId),
    };
    identity = buildIdentityModule({
      prisma,
      redis,
      clock: new SystemClock(),
      idGenerator: new UuidGenerator(),
      tenantExistenceChecker,
    });

    await seedPermissionCatalog(prisma);
    await seedSystemRoles(identity.repositories.roles);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  it("une session TENANT valide se propage jusqu'a une lecture RLS reussie du HealthFacility du tenant", async () => {
    const facilityResult = await tenant.handlers.createHealthFacility.execute({
      name: uniqueFacilityName('Etablissement Contexte Serveur'),
    });
    expect(facilityResult.isSuccess()).toBe(true);
    const tenantId = facilityResult.getValue().tenantId;

    const accountResult = await identity.handlers.createUserAccount.execute({
      email: uniqueEmail('server-context'),
      plainPassword: 'mot-de-passe-suffisant-1',
      platformRole: 'NONE',
    });
    expect(accountResult.isSuccess()).toBe(true);
    const userId = accountResult.getValue().userAccountId;

    const grant = await identity.handlers.grantMembership.execute({
      userId,
      tenantId,
      createdBy: userId,
      initialRoleCodes: ['MEDECIN'],
    });
    expect(grant.isSuccess()).toBe(true);

    const contextResult = await identity.handlers.resolveTenantContext.execute({
      userId,
      intent: { kind: 'TENANT', tenantId },
    });
    expect(contextResult.isSuccess()).toBe(true);
    const sessionId = (contextResult.getValue().session as TenantSessionContext).sessionId;

    // A partir d'ici, on ne connait plus QUE le sessionId — exactement ce qu'un middleware HTTP
    // recevrait d'un cookie/en-tete. Aucun tenantId n'est passe explicitement par l'appelant.
    const resolved = await identity.serverContextResolver.resolve(sessionId);
    expect(resolved.isSuccess()).toBe(true);
    const serverContext = resolved.getValue();
    expect(serverContext.kind).toBe('TENANT');

    const uowContext = identity.serverContextResolver.toUnitOfWorkContext(serverContext);
    expect(uowContext.tenantId?.toString()).toBe(tenantId);

    const facility = await identity.unitOfWork.withTransaction(
      () => tenant.repositories.healthFacilities.findByTenantId(TenantId.create(tenantId).getValue()),
      uowContext,
    );
    expect(facility).not.toBeNull();
    expect(facility?.id.toString()).toBe(tenantId);
  });

  it("un sessionId inconnu ne produit aucun ServerContext : aucune donnee tenant n'est accessible (RLS refuse par defaut)", async () => {
    const facilityResult = await tenant.handlers.createHealthFacility.execute({
      name: uniqueFacilityName('Etablissement Non Accessible'),
    });
    const tenantId = facilityResult.getValue().tenantId;

    const resolved = await identity.serverContextResolver.resolve('session-totalement-inconnue');
    expect(resolved.isFailure()).toBe(true);
    expect(resolved.getError()).toBe('SESSION_NOT_FOUND');

    // Sans ServerContext, aucun appelant legitime ne peut produire un UnitOfWorkContext porteur
    // d'un tenantId. On le verifie ici en interrogeant directement SANS contexte (equivalent a
    // ce qui se passerait si un bug applicatif oubliait quand meme d'en construire un) : le RLS
    // refuse par defaut, meme avec un identifiant de tenant parfaitement valide.
    const facility = await identity.unitOfWork.withTransaction(() =>
      tenant.repositories.healthFacilities.findByTenantId(TenantId.create(tenantId).getValue()),
    );
    expect(facility).toBeNull();
  });
});
