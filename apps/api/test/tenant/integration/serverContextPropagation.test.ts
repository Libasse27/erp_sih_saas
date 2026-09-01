import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { buildIdentityModule, type IdentityModule } from '../../../src/modules/identity/infrastructure/IdentityModule.js';
import type { TenantAccessChecker } from '../../../src/modules/identity/application/ports/TenantAccessChecker.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import type { TenantSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { buildTenantModule, type TenantModule } from '../../../src/modules/tenant/infrastructure/TenantModule.js';
import type { UserAccountExistenceChecker } from '../../../src/modules/tenant/application/ports/UserAccountExistenceChecker.js';
import { buildSubscriptionModule, seedPlanCatalog, type SubscriptionModule } from '../../../src/modules/subscription/infrastructure/SubscriptionModule.js';
import { PrismaUserAccountRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserAccountRepository.js';
import { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { createTestPrismaClient, createTestRedisClient, uniqueEmail, uniqueFacilityName } from '../../identity/integration/dbTestHelpers.js';
import { InMemoryAuditTrail, InMemoryMembershipAuditTrail, InMemorySessionAuditTrail } from '../../identity/builders/testKit.js';
import { InMemoryProvisioningAuditTrail } from '../builders/testKit.js';
import { InMemorySubscriptionAuditTrail } from '../../subscription/builders/testKit.js';

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
  let subscription: SubscriptionModule;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    redis = createTestRedisClient();
    // Reproduit fidelement `IdentityModuleBackedUserAccountExistenceChecker` de
    // composition-root.ts (ADR-0008 §9, amendement 1) — instance DEDIEE de
    // `PrismaUserAccountRepository`, construite AVANT `identity` (meme raisonnement que
    // composition-root.ts : Tenant a besoin de verifier l'existence d'un UserAccount sans
    // attendre la construction complete du module Identity, qui depend en retour de Tenant via
    // `TenantAccessChecker`).
    const userAccounts = new PrismaUserAccountRepository(prisma);
    const userAccountExistenceChecker: UserAccountExistenceChecker = {
      exists: async (userId: string) => {
        const idResult = UserAccountId.create(userId);
        if (idResult.isFailure()) {
          return false;
        }
        return (await userAccounts.findById(idResult.getValue())) !== null;
      },
    };
    tenant = buildTenantModule({
      prisma,
      clock: new SystemClock(),
      idGenerator: new UuidGenerator(),
      userAccountExistenceChecker,
      provisioningAuditTrail: new InMemoryProvisioningAuditTrail(),
    });
    subscription = buildSubscriptionModule({
      prisma,
      clock: new SystemClock(),
      idGenerator: new UuidGenerator(),
      subscriptionAuditTrail: new InMemorySubscriptionAuditTrail(),
    });
    // Reproduit fidelement TenantModuleBackedAccessChecker de composition-root.ts — compose
    // Subscription depuis ADR-0008 §3 (etape 10/13) : ACCESSIBLE exige desormais un Subscription
    // existant pour ce tenant, en plus de HealthFacility.isActive().
    const tenantAccessChecker: TenantAccessChecker = {
      checkAccess: async (tenantId) => {
        const facility = await tenant.repositories.healthFacilities.findByTenantId(tenantId);
        if (facility === null) {
          return 'NOT_FOUND';
        }
        if (!facility.isActive()) {
          return 'SUSPENDED';
        }
        const activeSubscription = await subscription.repositories.subscriptions.findByTenantId(tenantId);
        return activeSubscription === null ? 'NOT_FOUND' : 'ACCESSIBLE';
      },
    };
    identity = buildIdentityModule({
      prisma,
      redis,
      clock: new SystemClock(),
      idGenerator: new UuidGenerator(),
      tenantAccessChecker,
      auditTrail: new InMemoryAuditTrail(),
      sessionAuditTrail: new InMemorySessionAuditTrail(),
      membershipAuditTrail: new InMemoryMembershipAuditTrail(),
      mfa: {
        secretEncryptionKey: Buffer.alloc(32, 5),
        secretEncryptionKeyId: 'k1',
        recoveryCodePepper: 'server-context-propagation-test-pepper-32c',
        recoveryCodePepperId: 'p1',
        totpIssuer: 'SIH-TEST',
      },
      refreshToken: {
        hashPepper: 'server-context-propagation-test-refresh-token-pepper-32c',
        hashPepperId: 'p1',
      },
    });

    await seedPermissionCatalog(prisma);
    await seedSystemRoles(identity.repositories.roles);
    await seedPlanCatalog(subscription.repositories.plans, subscription.repositories.planPrices, new SystemClock(), new UuidGenerator());
  });

  afterAll(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  it("une session TENANT valide se propage jusqu'a une lecture RLS reussie du HealthFacility du tenant", async () => {
    const accountResult = await identity.handlers.createUserAccount.execute({
      email: uniqueEmail('server-context'),
      plainPassword: 'mot-de-passe-suffisant-1',
      platformRole: 'NONE',
    });
    expect(accountResult.isSuccess()).toBe(true);
    const userId = accountResult.getValue().userAccountId;

    const facilityResult = await tenant.handlers.createHealthFacility.execute({
      name: uniqueFacilityName('Etablissement Contexte Serveur'),
      ownerUserId: userId,
    });
    expect(facilityResult.isSuccess()).toBe(true);
    const tenantId = facilityResult.getValue().tenantId;
    const trialResult = await subscription.handlers.startTrialSubscription.execute({ tenantId, ownerUserId: userId });
    expect(trialResult.isSuccess()).toBe(true);

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
    const accountResult = await identity.handlers.createUserAccount.execute({
      email: uniqueEmail('unknown-session'),
      plainPassword: 'mot-de-passe-suffisant-1',
      platformRole: 'NONE',
    });
    const ownerUserId = accountResult.getValue().userAccountId;

    const facilityResult = await tenant.handlers.createHealthFacility.execute({
      name: uniqueFacilityName('Etablissement Non Accessible'),
      ownerUserId,
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

  it("un tenant SUSPENDED refuse l'ouverture d'un NOUVEAU contexte (TENANT_SUSPENDED), verifie contre le vrai statut Postgres (arbitrage architecte, 2026-08-24)", async () => {
    const accountResult = await identity.handlers.createUserAccount.execute({
      email: uniqueEmail('suspended-tenant'),
      plainPassword: 'mot-de-passe-suffisant-1',
      platformRole: 'NONE',
    });
    const userId = accountResult.getValue().userAccountId;

    const facilityResult = await tenant.handlers.createHealthFacility.execute({
      name: uniqueFacilityName('Etablissement A Suspendre'),
      ownerUserId: userId,
    });
    const tenantId = facilityResult.getValue().tenantId;
    const tenantIdVo = TenantId.create(tenantId).getValue();

    // ADR-0008 §3 : un Subscription TRIALING valide existe pour ce tenant AVANT la suspension —
    // la priorite du statut HealthFacility doit rester absolue MEME dans ce cas (pas seulement en
    // l'absence d'abonnement, ce que le test precedent ne prouvait pas a lui seul).
    const trialResult = await subscription.handlers.startTrialSubscription.execute({ tenantId, ownerUserId: userId });
    expect(trialResult.isSuccess()).toBe(true);

    // Suspend directement via le domain + repository (aucune commande applicative de suspension
    // n'existe encore — voir HealthFacility.ts) : c'est exactement ce que ferait le futur module
    // Subscription/mode degrade (O-03), sans qu'il faille l'anticiper ici.
    await tenant.unitOfWork.withTransaction(async () => {
      const facility = await tenant.repositories.healthFacilities.findByTenantId(tenantIdVo);
      if (facility === null) {
        throw new Error('HealthFacility introuvable juste apres sa creation.');
      }
      facility.suspend();
      await tenant.repositories.healthFacilities.save(facility, tenantIdVo);
    }, { tenantId: tenantIdVo });

    await identity.handlers.grantMembership.execute({
      userId,
      tenantId,
      createdBy: userId,
      initialRoleCodes: ['MEDECIN'],
    });

    const contextResult = await identity.handlers.resolveTenantContext.execute({
      userId,
      intent: { kind: 'TENANT', tenantId },
    });
    expect(contextResult.isFailure()).toBe(true);
    expect(contextResult.getError()).toBe('TENANT_SUSPENDED');
  });

  it("un tenant dont le HealthFacility est ACTIVE mais SANS Subscription est refuse comme s'il n'existait pas (TENANT_NOT_FOUND, ADR-0008 §3 — ferme la faille documentee au §Contexte de l'ADR)", async () => {
    // Aucun StartTrialSubscription n'est appele ici — reproduit exactement le scenario du
    // §Contexte d'ADR-0008 : CreateHealthFacility a reussi, StartTrialSubscription n'a pas
    // (encore) ete rejoue par l'Outbox (crash, message encore PENDING...).
    const accountResult = await identity.handlers.createUserAccount.execute({
      email: uniqueEmail('no-subscription-tenant'),
      plainPassword: 'mot-de-passe-suffisant-1',
      platformRole: 'NONE',
    });
    expect(accountResult.isSuccess()).toBe(true);
    const ownerUserId = accountResult.getValue().userAccountId;

    const facilityResult = await tenant.handlers.createHealthFacility.execute({
      name: uniqueFacilityName('Etablissement Sans Abonnement'),
      ownerUserId,
    });
    expect(facilityResult.isSuccess()).toBe(true);
    const tenantId = facilityResult.getValue().tenantId;
    const userId = ownerUserId;

    await identity.handlers.grantMembership.execute({
      userId,
      tenantId,
      createdBy: userId,
      initialRoleCodes: ['MEDECIN'],
    });

    const contextResult = await identity.handlers.resolveTenantContext.execute({
      userId,
      intent: { kind: 'TENANT', tenantId },
    });
    expect(contextResult.isFailure()).toBe(true);
    expect(contextResult.getError()).toBe('TENANT_NOT_FOUND');

    // Une fois l'essai demarre (etape suivante de la Saga, ADR-0008 §1), le MEME tenant devient
    // accessible SANS qu'aucun etat de progression de Saga n'ait ete touche — la lecture reste
    // TOUJOURS dynamique (ADR-0008 §3, precision "stateless vis-a-vis de la Saga elle-meme").
    const trialResult = await subscription.handlers.startTrialSubscription.execute({ tenantId, ownerUserId });
    expect(trialResult.isSuccess()).toBe(true);

    const retryResult = await identity.handlers.resolveTenantContext.execute({
      userId,
      intent: { kind: 'TENANT', tenantId },
    });
    expect(retryResult.isSuccess()).toBe(true);
  });
});
