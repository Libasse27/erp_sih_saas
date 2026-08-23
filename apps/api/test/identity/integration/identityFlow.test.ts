import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { buildIdentityModule, type IdentityModule } from '../../../src/modules/identity/infrastructure/IdentityModule.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import type { TenantSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { createTestPrismaClient, createTestRedisClient, uniqueEmail } from './dbTestHelpers.js';

/**
 * Tests d'integration bout en bout du module Identity + RBAC + UserTenantMembership contre une
 * vraie instance PostgreSQL (RLS actif) et Redis. Necessite `docker compose up -d` et les
 * migrations appliquees. Couvre les criteres d'acceptation explicites de l'etape 2.7.
 */
describe('Identity — flux integres (Prisma + Redis reels)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let identity: IdentityModule;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    redis = createTestRedisClient();
    identity = buildIdentityModule({ prisma, redis, clock: new SystemClock(), idGenerator: new UuidGenerator() });

    await seedPermissionCatalog(prisma);
    await seedSystemRoles(identity.repositories.roles);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  async function createAccount(): Promise<{ userId: string; email: string; password: string }> {
    const email = uniqueEmail('flow');
    const password = 'mot-de-passe-suffisant-1';
    const result = await identity.handlers.createUserAccount.execute({ email, plainPassword: password, platformRole: 'NONE' });
    if (result.isFailure()) {
      throw new Error(`Echec creation compte: ${result.getError()}`);
    }
    return { userId: result.getValue().userAccountId, email, password };
  }

  it('un utilisateur avec deux memberships dans deux etablissements peut selectionner l_un ou l_autre au login', async () => {
    const { userId, email, password } = await createAccount();
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    const grantA = await identity.handlers.grantMembership.execute({
      userId,
      tenantId: tenantA,
      createdBy: userId,
      initialRoleCodes: ['MEDECIN'],
    });
    const grantB = await identity.handlers.grantMembership.execute({
      userId,
      tenantId: tenantB,
      createdBy: userId,
      initialRoleCodes: ['MEDECIN'],
    });
    expect(grantA.isSuccess()).toBe(true);
    expect(grantB.isSuccess()).toBe(true);

    const auth = await identity.handlers.authenticateUser.execute({ email, plainPassword: password });
    expect(auth.isSuccess()).toBe(true);
    expect(new Set(auth.getValue().activeTenantIds)).toEqual(new Set([tenantA, tenantB]));

    const contextA = await identity.handlers.resolveTenantContext.execute({
      userId,
      intent: { kind: 'TENANT', tenantId: tenantA },
    });
    const contextB = await identity.handlers.resolveTenantContext.execute({
      userId,
      intent: { kind: 'TENANT', tenantId: tenantB },
    });
    expect(contextA.isSuccess()).toBe(true);
    expect(contextB.isSuccess()).toBe(true);
    expect((contextA.getValue().session as TenantSessionContext).tenantId).toBe(tenantA);
    expect((contextB.getValue().session as TenantSessionContext).tenantId).toBe(tenantB);
  });

  it('un membership avec deux roles simultanes obtient l_union de leurs permissions', async () => {
    const { userId } = await createAccount();
    const tenantId = randomUUID();

    const grant = await identity.handlers.grantMembership.execute({
      userId,
      tenantId,
      createdBy: userId,
      initialRoleCodes: ['INFIRMIER', 'RESPONSABLE_RH'],
    });
    expect(grant.isSuccess()).toBe(true);

    const context = await identity.handlers.resolveTenantContext.execute({
      userId,
      intent: { kind: 'TENANT', tenantId },
    });
    expect(context.isSuccess()).toBe(true);
    const session = context.getValue().session as TenantSessionContext;
    expect(session.permissionCodes).toEqual(
      expect.arrayContaining(['patient:read', 'encounter:read', 'vital-signs:write', 'staff-member:write']),
    );
  });

  it('maxUsers compte 1 pour un membership porteur de trois roles', async () => {
    const { userId } = await createAccount();
    const tenantId = randomUUID();

    const grant = await identity.handlers.grantMembership.execute({
      userId,
      tenantId,
      createdBy: userId,
      initialRoleCodes: ['MEDECIN', 'RESPONSABLE_RH', 'RESPONSABLE_STOCK'],
    });
    expect(grant.isSuccess()).toBe(true);

    // countActive() est une lecture tenant-scoped : comme tout appel repository de ce module,
    // elle doit passer par le UnitOfWork pour que `app.tenant_id` soit positionne (sinon la
    // politique RLS bloque la ligne malgre un WHERE applicatif correct — c'est precisement la
    // garantie de defense en profondeur de la couche 4).
    const tenant = TenantId.create(tenantId).getValue();
    const activeCount = await identity.unitOfWork.withTransaction(
      () => identity.repositories.memberships.countActive(tenant),
      { tenantId: tenant },
    );
    expect(activeCount).toBe(1);
  });

  it('requiresMfa est vrai des qu_un seul role du membership l_exige', async () => {
    const { userId } = await createAccount();
    const tenantId = randomUUID();

    await identity.handlers.grantMembership.execute({
      userId,
      tenantId,
      createdBy: userId,
      initialRoleCodes: ['INFIRMIER', 'ADMIN_ETABLISSEMENT'],
    });

    const context = await identity.handlers.resolveTenantContext.execute({ userId, intent: { kind: 'TENANT', tenantId } });
    expect(context.isSuccess()).toBe(true);
    expect((context.getValue().session as TenantSessionContext).requiresMfa).toBe(true);
  });

  it('la revocation d_un membership empeche l_ouverture d_un nouveau contexte pour ce tenant', async () => {
    const { userId } = await createAccount();
    const tenantId = randomUUID();

    const grant = await identity.handlers.grantMembership.execute({
      userId,
      tenantId,
      createdBy: userId,
      initialRoleCodes: ['MEDECIN'],
    });
    expect(grant.isSuccess()).toBe(true);
    const membershipId = grant.getValue().membershipId;

    const revoke = await identity.handlers.revokeMembership.execute({ membershipId, tenantId });
    expect(revoke.isSuccess()).toBe(true);

    const context = await identity.handlers.resolveTenantContext.execute({ userId, intent: { kind: 'TENANT', tenantId } });
    expect(context.isFailure()).toBe(true);
    expect(context.getError()).toBe('MEMBERSHIP_NOT_FOUND_OR_INACTIVE');
  });

  it("le changement d'etablissement ferme le contexte courant et en ouvre un nouveau, sans etat partage", async () => {
    const { userId } = await createAccount();
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    await identity.handlers.grantMembership.execute({ userId, tenantId: tenantA, createdBy: userId, initialRoleCodes: ['MEDECIN'] });
    await identity.handlers.grantMembership.execute({ userId, tenantId: tenantB, createdBy: userId, initialRoleCodes: ['MEDECIN'] });

    const first = await identity.handlers.resolveTenantContext.execute({ userId, intent: { kind: 'TENANT', tenantId: tenantA } });
    const firstSessionId = first.getValue().session.sessionId;

    const second = await identity.handlers.resolveTenantContext.execute({
      userId,
      intent: { kind: 'TENANT', tenantId: tenantB },
      previousSessionId: firstSessionId,
    });
    expect(second.isSuccess()).toBe(true);
    const secondSession = second.getValue().session;

    expect(secondSession.sessionId).not.toBe(firstSessionId);
    expect(await redis.exists(`sih:session:${firstSessionId}`)).toBe(0);
    expect(await redis.exists(`sih:session:${secondSession.sessionId}`)).toBe(1);
  });

  it('un client qui fournit un tenantId dont il n_est pas membre est refuse par ResolveTenantContext', async () => {
    const { userId } = await createAccount();
    const foreignTenantId = randomUUID();

    const context = await identity.handlers.resolveTenantContext.execute({
      userId,
      intent: { kind: 'TENANT', tenantId: foreignTenantId },
    });
    expect(context.isFailure()).toBe(true);
    expect(context.getError()).toBe('MEMBERSHIP_NOT_FOUND_OR_INACTIVE');
  });

  it('AuthenticateUser rejette un mot de passe incorrect avec argon2id reel', async () => {
    const { email } = await createAccount();
    const result = await identity.handlers.authenticateUser.execute({ email, plainPassword: 'mauvais-mot-de-passe' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_CREDENTIALS');
  });
});
