import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { buildIdentityModule, type IdentityModule } from '../../../src/modules/identity/infrastructure/IdentityModule.js';
import type { TenantAccessChecker } from '../../../src/modules/identity/application/ports/TenantAccessChecker.js';
import type { TenantSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import { PrismaUserAccountRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserAccountRepository.js';
import { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { UserTenantMembershipId } from '../../../src/modules/identity/domain/value-objects/UserTenantMembershipId.js';
import { buildTenantModule, type TenantModule } from '../../../src/modules/tenant/infrastructure/TenantModule.js';
import type { UserAccountExistenceChecker } from '../../../src/modules/tenant/application/ports/UserAccountExistenceChecker.js';
import { buildSubscriptionModule, seedPlanCatalog, type SubscriptionModule } from '../../../src/modules/subscription/infrastructure/SubscriptionModule.js';
import { InMemoryProvisioningAuditTrail } from '../../tenant/builders/testKit.js';
import { InMemorySubscriptionAuditTrail } from '../../subscription/builders/testKit.js';
import { InMemoryAuditTrail, InMemoryMembershipAuditTrail, InMemorySessionAuditTrail } from '../builders/testKit.js';
import { createTestPrismaClient, createTestRedisClient, uniqueEmail, uniqueFacilityName } from './dbTestHelpers.js';

/**
 * Preuve d'integration reelle (PostgreSQL + Redis) de l'isolation tenant du refresh token
 * (Phase 0, etape 12/13, "Tests d'isolation multi-tenant/securite" — lacune CRITIQUE remontee par
 * l'audit securite : `platform.RefreshToken` est HORS RLS (ADR-0006 §4, meme regime que
 * `MfaEnrollment`/`AuditEntry` — concept d'identite/session globale, pas une ressource
 * tenant-scopee) donc l'isolation entre tenants ne peut structurellement PAS reposer sur le RLS
 * Postgres ici : elle est purement APPLICATIVE (le tenantId d'une chaine est fige a l'emission —
 * `RefreshTokenIssuer.issueChain` — et redecoule EXCLUSIVEMENT de `record.tenantId`, jamais d'un
 * parametre transmis par l'appelant : `RefreshSessionCommand` ne porte d'ailleurs aucun champ
 * `tenantId`, voir RefreshSession.ts). Ce fichier le prouve au niveau du HANDLER
 * (`RefreshSessionHandler`, `RevokeMembershipHandler`) ET au niveau des LIGNES PERSISTEES
 * (`platform.RefreshToken`, lues en direct via Prisma comme dans refreshTokenRotation.test.ts).
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('Refresh token — isolation tenant (etape 12/13, ADR-0006 §4/§6)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let identity: IdentityModule;
  let tenant: TenantModule;
  let subscription: SubscriptionModule;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    redis = createTestRedisClient();
    // Reproduit fidelement `IdentityModuleBackedUserAccountExistenceChecker` de
    // composition-root.ts (ADR-0008 §9, amendement 1) — voir le meme commentaire dans
    // refreshTokenRotation.test.ts / serverContextPropagation.test.ts.
    const userAccountsForExistenceCheck = new PrismaUserAccountRepository(prisma);
    const userAccountExistenceChecker: UserAccountExistenceChecker = {
      exists: async (userId: string) => {
        const idResult = UserAccountId.create(userId);
        if (idResult.isFailure()) {
          return false;
        }
        return (await userAccountsForExistenceCheck.findById(idResult.getValue())) !== null;
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
    // Compose Subscription depuis ADR-0008 §3 (etape 10/13) : ACCESSIBLE exige desormais un
    // Subscription existant.
    const tenantAccessChecker: TenantAccessChecker = {
      checkAccess: async (tenantId) => {
        const facility = await tenant.repositories.healthFacilities.findByTenantId(tenantId);
        if (facility === null) return 'NOT_FOUND';
        if (!facility.isActive()) return 'SUSPENDED';
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
        secretEncryptionKey: Buffer.alloc(32, 23),
        secretEncryptionKeyId: 'k1',
        recoveryCodePepper: 'refresh-token-tenant-isolation-test-recovery-pepper-32c',
        recoveryCodePepperId: 'p1',
        totpIssuer: 'SIH-TEST',
      },
      refreshToken: {
        hashPepper: 'refresh-token-tenant-isolation-test-refresh-pepper-32c',
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

  async function createAccount(): Promise<{ userId: string; email: string }> {
    const email = uniqueEmail('refresh-iso');
    const result = await identity.handlers.createUserAccount.execute({
      email,
      plainPassword: 'mot-de-passe-suffisant-1',
      platformRole: 'NONE',
    });
    if (result.isFailure()) throw new Error(`Echec creation compte: ${result.getError()}`);
    return { userId: result.getValue().userAccountId, email };
  }

  /** Provisionne un `HealthFacility` ET demarre son essai gratuit — meme discipline que refreshTokenRotation.test.ts. `ownerUserId` : compte proprietaire JETABLE, distinct de l'utilisateur dont ce fichier teste l'isolation multi-tenant. */
  async function createFacilityTenantId(): Promise<string> {
    const owner = await createAccount();
    const result = await tenant.handlers.createHealthFacility.execute({
      name: uniqueFacilityName('Etablissement Isolation Refresh'),
      ownerUserId: owner.userId,
    });
    if (result.isFailure()) throw new Error(`Echec creation etablissement: ${result.getError()}`);
    const trial = await subscription.handlers.startTrialSubscription.execute({
      tenantId: result.getValue().tenantId,
      ownerUserId: owner.userId,
    });
    if (trial.isFailure()) throw new Error(`Echec demarrage essai: ${trial.getError()}`);
    return result.getValue().tenantId;
  }

  /** Ouvre un contexte TENANT complet (jamais `MFA_PENDING`, role MEDECIN non soumis au MFA) SANS `previousSessionId` — deux appels successifs sur deux tenants distincts pour le MEME `userId` laissent donc les DEUX chaines actives CONCURREMMENT (scenario multi-etablissement reel, O-05). */
  async function openTenantSession(userId: string, tenantId: string): Promise<{ sessionId: string; refreshToken: string; membershipId: string }> {
    const context = await identity.handlers.resolveTenantContext.execute({ userId, intent: { kind: 'TENANT', tenantId } });
    if (context.isFailure()) throw new Error(`Echec resolveTenantContext: ${context.getError()}`);
    const { session, refreshToken } = context.getValue();
    if (refreshToken === null) throw new Error('Aucun refresh token emis pour une session complete.');
    if (session.kind !== 'TENANT') throw new Error(`Session inattendue: ${session.kind}`);
    return { sessionId: session.sessionId, refreshToken, membershipId: session.membershipId };
  }

  async function grantMedecin(userId: string, tenantId: string): Promise<void> {
    const grant = await identity.handlers.grantMembership.execute({
      userId,
      tenantId,
      createdBy: userId,
      initialRoleCodes: ['MEDECIN'],
    });
    if (grant.isFailure()) throw new Error(`Echec grant: ${grant.getError()}`);
  }

  /** Deux tenants distincts, un seul utilisateur membre des deux (MEDECIN), deux chaines de refresh actives simultanement — le montage commun a tous les tests de ce fichier. */
  async function setupUserWithTwoTenants(): Promise<{
    userId: string;
    tenantA: string;
    tenantB: string;
    sessionA: { sessionId: string; refreshToken: string; membershipId: string };
    sessionB: { sessionId: string; refreshToken: string; membershipId: string };
  }> {
    const { userId } = await createAccount();
    const tenantA = await createFacilityTenantId();
    const tenantB = await createFacilityTenantId();
    await grantMedecin(userId, tenantA);
    await grantMedecin(userId, tenantB);
    const sessionA = await openTenantSession(userId, tenantA);
    const sessionB = await openTenantSession(userId, tenantB);
    return { userId, tenantA, tenantB, sessionA, sessionB };
  }

  it('deux chaines actives du meme utilisateur sur deux tenants distincts : le refresh de la chaine A ne produit JAMAIS un contexte tenant B (et reciproquement), meme si les deux memberships sont valides simultanement', async () => {
    const { tenantA, tenantB, sessionA, sessionB } = await setupUserWithTwoTenants();

    // Les deux lignes persistees portent chacune leur PROPRE tenantId — jamais celui de l'autre,
    // jamais null (RefreshTokenIssuer.issueChain fige `tenantId` a l'emission depuis le
    // SessionContext deja resolu, voir RefreshTokenIssuer.ts).
    const rowA = await prisma.refreshToken.findFirst({ where: { sessionId: sessionA.sessionId } });
    const rowB = await prisma.refreshToken.findFirst({ where: { sessionId: sessionB.sessionId } });
    expect(rowA?.tenantId).toBe(tenantA);
    expect(rowB?.tenantId).toBe(tenantB);
    expect(rowA?.chainId).not.toBe(rowB?.chainId);

    // Refresh de la chaine A : RefreshSessionCommand ne porte AUCUN champ tenantId (voir
    // RefreshSession.ts) — le contexte resultant ne peut structurellement provenir que du
    // `tenantId` fige sur la ligne presentee, jamais d'un tenant choisi par l'appelant.
    const refreshedA = await identity.handlers.refreshSession.execute({ refreshToken: sessionA.refreshToken });
    expect(refreshedA.isSuccess()).toBe(true);
    const sessionAfterRefreshA = refreshedA.getValue().session as TenantSessionContext;
    expect(sessionAfterRefreshA.kind).toBe('TENANT');
    expect(sessionAfterRefreshA.tenantId).toBe(tenantA);
    expect(sessionAfterRefreshA.tenantId).not.toBe(tenantB);
    expect(sessionAfterRefreshA.membershipId).toBe(sessionA.membershipId);
    expect(sessionAfterRefreshA.membershipId).not.toBe(sessionB.membershipId);

    // La chaine B, jamais presentee, reste totalement INTACTE : ni sa ligne ni sa session Redis
    // ne sont affectees par le refresh de la chaine A (aucune fuite croisee au niveau du
    // repository).
    const rowBAfter = await prisma.refreshToken.findFirst({ where: { sessionId: sessionB.sessionId } });
    expect(rowBAfter?.status).toBe('ACTIVE');
    const contextB = await identity.serverContextResolver.resolve(sessionB.sessionId);
    expect(contextB.isSuccess()).toBe(true);
    const contextBValue = contextB.getValue();
    expect(contextBValue.kind).toBe('TENANT');
    if (contextBValue.kind === 'TENANT') {
      expect(contextBValue.tenantId.toString()).toBe(tenantB);
    }

    // Symetrique : refresh de la chaine B (jamais encore consommee) -> contexte tenant B, jamais A.
    const refreshedB = await identity.handlers.refreshSession.execute({ refreshToken: sessionB.refreshToken });
    expect(refreshedB.isSuccess()).toBe(true);
    const sessionAfterRefreshB = refreshedB.getValue().session as TenantSessionContext;
    expect(sessionAfterRefreshB.tenantId).toBe(tenantB);
    expect(sessionAfterRefreshB.membershipId).toBe(sessionB.membershipId);
  });

  it("le refresh token de la chaine A, presente APRES revocation directe du membership tenant A (hors chaine), echoue explicitement (CONTEXT_NO_LONGER_AVAILABLE) — jamais un repli implicite vers le contexte tenant B, meme si l'acces au tenant B reste valide pour le meme utilisateur", async () => {
    const { tenantA, tenantB, sessionA, sessionB } = await setupUserWithTwoTenants();

    // Revocation du SEUL membership tenant A, directement au niveau du domaine/repository — sans
    // passer par `RevokeMembershipHandler` (qui aurait deja ferme la chaine cote
    // RefreshToken/SessionStore, voir le test suivant) : reproduit fidelement le cas ou la ligne
    // `platform.RefreshToken` est encore techniquement ACTIVE au moment du refresh
    // (`SessionContextIssuer.resolveMaterials` doit alors refuser tout seul, en dernier ressort —
    // voir issueForRefresh).
    const tenantAVo = TenantId.create(tenantA).getValue();
    const membershipAVo = UserTenantMembershipId.create(sessionA.membershipId).getValue();
    await identity.unitOfWork.withTransaction(async () => {
      const membership = await identity.repositories.memberships.findById(membershipAVo, tenantAVo);
      if (membership === null) throw new Error('Membership tenant A introuvable.');
      const revokeResult = membership.revoke(new SystemClock(), new UuidGenerator());
      if (revokeResult.isFailure()) throw new Error(`Echec revoke: ${revokeResult.getError()}`);
      await identity.repositories.memberships.save(membership, tenantAVo);
    }, { tenantId: tenantAVo });

    const rowABeforeRefresh = await prisma.refreshToken.findFirst({ where: { sessionId: sessionA.sessionId } });
    expect(rowABeforeRefresh?.status).toBe('ACTIVE');

    const refreshedA = await identity.handlers.refreshSession.execute({ refreshToken: sessionA.refreshToken });
    expect(refreshedA.isFailure()).toBe(true);
    expect(refreshedA.getError()).toBe('CONTEXT_NO_LONGER_AVAILABLE');

    // La chaine tenant B, totalement independante, reste utilisable normalement : la preuve que
    // l'echec ci-dessus n'a jamais fait basculer quoi que ce soit vers un autre tenant, ni affecte
    // par ricochet une chaine du meme utilisateur sur un tenant different.
    const refreshedB = await identity.handlers.refreshSession.execute({ refreshToken: sessionB.refreshToken });
    expect(refreshedB.isSuccess()).toBe(true);
    const sessionAfterRefreshB = refreshedB.getValue().session as TenantSessionContext;
    expect(sessionAfterRefreshB.tenantId).toBe(tenantB);
  });

  it("`RevokeMembershipHandler` sur le membership tenant A ne revoque QUE la chaine de refresh du tenant A (`revokeAllForMembership`, scope par `membershipId`) — la chaine tenant B du MEME utilisateur n'est ni lue ni modifiee", async () => {
    const { tenantA, tenantB, sessionA, sessionB } = await setupUserWithTwoTenants();

    const revoke = await identity.handlers.revokeMembership.execute({ membershipId: sessionA.membershipId, tenantId: tenantA });
    expect(revoke.isSuccess()).toBe(true);

    // Chaine A : revoquee (raison MEMBERSHIP_REVOKED), session Redis fermee.
    const rowsA = await prisma.refreshToken.findMany({ where: { sessionId: sessionA.sessionId } });
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]?.status).toBe('REVOKED');
    expect(rowsA[0]?.revokedReason).toBe('MEMBERSHIP_REVOKED');
    const contextA = await identity.serverContextResolver.resolve(sessionA.sessionId);
    expect(contextA.isFailure()).toBe(true);
    expect(contextA.getError()).toBe('SESSION_NOT_FOUND');

    // Chaine B : le repository `platform.RefreshToken` (hors RLS, filtre uniquement par
    // `membershipId`) ne touche NI ne retourne la ligne du tenant B pour ce meme utilisateur —
    // statut inchange, refresh toujours possible, contexte toujours celui du tenant B.
    const rowsB = await prisma.refreshToken.findMany({ where: { sessionId: sessionB.sessionId } });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.status).toBe('ACTIVE');
    expect(rowsB[0]?.revokedReason).toBeNull();
    const refreshedB = await identity.handlers.refreshSession.execute({ refreshToken: sessionB.refreshToken });
    expect(refreshedB.isSuccess()).toBe(true);
    const sessionAfterRefreshB = refreshedB.getValue().session as TenantSessionContext;
    expect(sessionAfterRefreshB.tenantId).toBe(tenantB);
    expect(sessionAfterRefreshB.tenantId).not.toBe(tenantA);
  });
});
