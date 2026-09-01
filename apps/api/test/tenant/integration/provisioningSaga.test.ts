import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import type { OutboxEventEnvelope } from '../../../src/shared-kernel/application/OutboxEventHandler.js';
import { buildTenantModule, type TenantModule } from '../../../src/modules/tenant/infrastructure/TenantModule.js';
import type { UserAccountExistenceChecker } from '../../../src/modules/tenant/application/ports/UserAccountExistenceChecker.js';
import { buildSubscriptionModule, seedPlanCatalog, type SubscriptionModule } from '../../../src/modules/subscription/infrastructure/SubscriptionModule.js';
import { StartTrialSubscriptionHandler } from '../../../src/modules/subscription/application/commands/StartTrialSubscription.js';
import { createStartTrialSubscriptionOnHealthFacilityCreatedHandler } from '../../../src/modules/subscription/application/services/StartTrialSubscriptionOnHealthFacilityCreated.js';
import { buildIdentityModule, type IdentityModule } from '../../../src/modules/identity/infrastructure/IdentityModule.js';
import type { TenantAccessChecker, TenantAccessStatus } from '../../../src/modules/identity/application/ports/TenantAccessChecker.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import { PrismaUserAccountRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserAccountRepository.js';
import { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { InMemoryAuditTrail, InMemoryMembershipAuditTrail, InMemorySessionAuditTrail } from '../../identity/builders/testKit.js';
import { InMemoryPlanPriceRepository, InMemoryPlanRepository, InMemorySubscriptionAuditTrail } from '../../subscription/builders/testKit.js';
import { InMemoryProvisioningAuditTrail } from '../../tenant/builders/testKit.js';
import { createTestRedisClient, uniqueEmail } from '../../identity/integration/dbTestHelpers.js';
import { createRawPgClient, createTestPrismaClient, uniqueFacilityName } from './dbTestHelpers.js';

/**
 * Preuve d'integration reelle (PostgreSQL + Redis) de la Saga de provisioning COMPLETE (ADR-0008
 * §1/§4/§9/§10/§11, amendement 1, Phase 0 etape 10/13) : les QUATRE etapes chorographiees,
 * invoquees DIRECTEMENT (sans passer par le relais BullMQ reel — deja teste adversarialement par
 * ailleurs, voir startTrialSubscriptionOnHealthFacilityCreatedConsumer.test.ts pour la meme
 * discipline). Couvre la liste "Tests attendus" d'ADR-0008 (fin de fichier, y compris
 * l'amendement 1) non deja couverte par les tests unitaires de chaque consommateur pris
 * isolement : propagation fidele d'`ownerUserId` bout en bout, rejeu idempotent a CHAQUE etape,
 * `ProvisioningCompleted` jamais consulte par l'AccessChecker.
 *
 * **RESEQUENCEMENT F3 (revue de securite independante de l'etape 10/13, finding Moyen)** : la
 * chaine est desormais STRICTEMENT SEQUENTIELLE — `HealthFacilityCreated → StartTrialSubscription
 * → SubscriptionStarted → GrantMembership → MembershipGranted → SeedFacilityConfiguration →
 * StartOnboarding → ProvisioningCompleted` (voir composition-root.ts, section "Saga de
 * provisioning", pour le detail du recablage). `identity.grantOwnerMembershipOnSubscriptionStarted`
 * (ex-`grantOwnerMembershipOnHealthFacilityCreated`, qui etait branche EN PARALLELE de
 * `startTrialSubscriptionOnHealthFacilityCreated` sur le MEME `eventType`) consomme desormais
 * `SubscriptionStarted`, jamais `HealthFacilityCreated` directement — ce fichier prouve que
 * `MembershipGranted` ne peut plus preceder `SubscriptionStarted`.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('Saga de provisioning — chaine complete reelle (ADR-0008, amendement 1, resequencement F3)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let rawClient: Awaited<ReturnType<typeof createRawPgClient>>;
  let tenant: TenantModule;
  let subscription: SubscriptionModule;
  let identity: IdentityModule;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    redis = createTestRedisClient();
    rawClient = await createRawPgClient();

    // Reproduit fidelement `IdentityModuleBackedUserAccountExistenceChecker` de
    // composition-root.ts (ADR-0008 §9, amendement 1).
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

    // Reproduit fidelement `TenantModuleBackedAccessChecker` de composition-root.ts (ADR-0008 §3)
    // — utilise aussi directement plus bas (`resolveAccess`) pour prouver la statelessness
    // vis-a-vis de la Saga (§3/§11).
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
        secretEncryptionKey: Buffer.alloc(32, 7),
        secretEncryptionKeyId: 'k1',
        recoveryCodePepper: 'provisioning-saga-test-recovery-pepper-32c',
        recoveryCodePepperId: 'p1',
        totpIssuer: 'SIH-TEST',
      },
      refreshToken: {
        hashPepper: 'provisioning-saga-test-refresh-token-pepper-32c',
        hashPepperId: 'p1',
      },
    });

    await seedPermissionCatalog(prisma);
    await seedSystemRoles(identity.repositories.roles);
    await seedPlanCatalog(subscription.repositories.plans, subscription.repositories.planPrices, new SystemClock(), new UuidGenerator());
  });

  afterAll(async () => {
    await rawClient.end();
    await prisma.$disconnect();
    redis.disconnect();
  });

  /**
   * Reproduit EXACTEMENT `TenantModuleBackedAccessChecker.checkAccess()` (ADR-0008 §3) — jamais
   * `ProvisioningCompleted`. `HealthFacility` est sous RLS FORCE (schema `public`) : la lecture
   * DOIT passer par le repository sous un contexte transactionnel qui positionne `app.tenant_id`
   * (jamais une requete brute, voir le meme choix dans
   * startTrialSubscriptionOnHealthFacilityCreatedConsumer.test.ts) — exactement ce que fait
   * `SessionContextIssuer` en production (voir son appel a `tenantAccessChecker.checkAccess()`,
   * toujours sous `unitOfWork.withTransaction(..., { tenantId })`).
   */
  async function resolveAccess(tenantId: string): Promise<TenantAccessStatus> {
    const tenantIdVo = TenantId.create(tenantId).getValue();
    const facility = await tenant.unitOfWork.withTransaction(
      () => tenant.repositories.healthFacilities.findByTenantId(tenantIdVo),
      { tenantId: tenantIdVo },
    );
    if (facility === null) {
      return 'NOT_FOUND';
    }
    if (!facility.isActive()) {
      return 'SUSPENDED';
    }
    const activeSubscription = await subscription.repositories.subscriptions.findByTenantId(tenantIdVo);
    return activeSubscription === null ? 'NOT_FOUND' : 'ACCESSIBLE';
  }

  async function findMembership(tenantId: string, ownerUserId: string) {
    const tenantIdVo = TenantId.create(tenantId).getValue();
    const ownerIdVo = UserAccountId.create(ownerUserId).getValue();
    return identity.unitOfWork.withTransaction(
      () => identity.repositories.memberships.findActiveByUserAndTenant(ownerIdVo, tenantIdVo),
      { tenantId: tenantIdVo },
    );
  }

  async function createOwner(prefix: string): Promise<string> {
    const result = await identity.handlers.createUserAccount.execute({
      email: uniqueEmail(prefix),
      plainPassword: 'mot-de-passe-suffisant-1',
      platformRole: 'NONE',
    });
    if (result.isFailure()) {
      throw new Error(`Echec creation compte proprietaire: ${result.getError()}`);
    }
    return result.getValue().userAccountId;
  }

  async function createFacility(namePrefix: string, ownerUserId: string): Promise<string> {
    const result = await tenant.handlers.createHealthFacility.execute({
      name: uniqueFacilityName(namePrefix),
      ownerUserId,
    });
    if (result.isFailure()) {
      throw new Error(`Echec creation etablissement: ${result.getError()}`);
    }
    return result.getValue().tenantId;
  }

  function healthFacilityCreatedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
    return {
      id: `hfc-${tenantId}`,
      eventType: 'tenant.health-facility.created',
      eventVersion: 1,
      aggregateId: tenantId,
      tenantId,
      occurredAt: new Date('2026-08-28T09:00:00Z'),
      payload: { name: 'Etablissement Saga', ownerUserId },
    };
  }

  /** Second maillon de la chaine resequencee (F3) : `ownerUserId` est desormais porte PAR CET evenement (voir events/SubscriptionStarted.ts), plus par `HealthFacilityCreated` seul. */
  function subscriptionStartedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
    return {
      id: `ss-${tenantId}`,
      eventType: 'subscription.subscription.started',
      eventVersion: 1,
      aggregateId: `subscription-${tenantId}`,
      tenantId,
      occurredAt: new Date('2026-08-28T09:02:00Z'),
      payload: { planId: `plan-${tenantId}`, trialEndsAt: '2026-09-27T09:02:00Z', ownerUserId },
    };
  }

  function membershipGrantedEnvelope(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
    return {
      id: `mg-${tenantId}`,
      eventType: 'identity.membership.granted',
      eventVersion: 1,
      aggregateId: `membership-${tenantId}`,
      tenantId,
      occurredAt: new Date('2026-08-28T09:05:00Z'),
      payload: { userId: ownerUserId },
    };
  }

  function facilityConfigurationSeededEnvelope(tenantId: string): OutboxEventEnvelope {
    return {
      id: `fcs-${tenantId}`,
      eventType: 'tenant.facility-configuration-seeded',
      eventVersion: 1,
      aggregateId: `settings-${tenantId}`,
      tenantId,
      occurredAt: new Date('2026-08-28T09:10:00Z'),
      payload: { locale: 'fr-SN', timezone: 'Africa/Dakar', currency: 'XOF', phoneCountryCode: '+221' },
    };
  }

  async function runFullSaga(tenantId: string, ownerUserId: string): Promise<void> {
    await subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(
      healthFacilityCreatedEnvelope(tenantId, ownerUserId),
    );
    await identity.outboxHandlers.grantOwnerMembershipOnSubscriptionStarted(
      subscriptionStartedEnvelope(tenantId, ownerUserId),
    );
    await tenant.outboxHandlers.seedFacilityConfigurationOnMembershipGranted(
      membershipGrantedEnvelope(tenantId, ownerUserId),
    );
    await tenant.outboxHandlers.completeProvisioningOnFacilityConfigurationSeeded(
      facilityConfigurationSeededEnvelope(tenantId),
    );
  }

  it('chaine complete bout en bout : ownerUserId propage fidelement jusqu_a ADMIN_ETABLISSEMENT, configuration semee, ProvisioningCompleted jamais consulte par l_AccessChecker', async () => {
    const ownerUserId = await createOwner('saga-e2e-owner');
    const tenantId = await createFacility('Etablissement Saga E2E', ownerUserId);

    await subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(
      healthFacilityCreatedEnvelope(tenantId, ownerUserId),
    );
    await identity.outboxHandlers.grantOwnerMembershipOnSubscriptionStarted(
      subscriptionStartedEnvelope(tenantId, ownerUserId),
    );

    // ADR-0008 §3/§11 : l'acces est DEJA ACCESSIBLE ici (HealthFacility + Subscription suffisent),
    // AVANT meme que SeedFacilityConfiguration/CompleteProvisioning n'aient tourne.
    expect(await resolveAccess(tenantId)).toBe('ACCESSIBLE');

    // Le membership admin porte EXACTEMENT ownerUserId — jamais un identifiant relu ou deduit
    // d'ailleurs (ADR-0008 §9, amendement 1, "Tests attendus").
    const tenantIdVo = TenantId.create(tenantId).getValue();
    const membership = await findMembership(tenantId, ownerUserId);
    expect(membership).not.toBeNull();
    const adminRole = await identity.repositories.roles.findSystemRoleByCode('ADMIN_ETABLISSEMENT');
    if (adminRole === null) {
      throw new Error('Role systeme ADMIN_ETABLISSEMENT introuvable — catalogue non seede.');
    }
    expect(membership?.roleIds.some((roleId) => roleId.equals(adminRole.id))).toBe(true);

    await tenant.outboxHandlers.seedFacilityConfigurationOnMembershipGranted(
      membershipGrantedEnvelope(tenantId, ownerUserId),
    );
    const settingsAfterSeed = await tenant.unitOfWork.withTransaction(
      () => tenant.repositories.facilitySettings.findByTenantId(tenantIdVo),
      { tenantId: tenantIdVo },
    );
    expect(settingsAfterSeed?.locale).toBe('fr-SN');
    expect(settingsAfterSeed?.timezone).toBe('Africa/Dakar');
    expect(settingsAfterSeed?.currency).toBe('XOF');
    expect(settingsAfterSeed?.phoneCountryCode).toBe('+221');
    expect(settingsAfterSeed?.isProvisioningCompleted()).toBe(false);

    await tenant.outboxHandlers.completeProvisioningOnFacilityConfigurationSeeded(
      facilityConfigurationSeededEnvelope(tenantId),
    );
    const settingsAfterCompletion = await tenant.unitOfWork.withTransaction(
      () => tenant.repositories.facilitySettings.findByTenantId(tenantIdVo),
      { tenantId: tenantIdVo },
    );
    expect(settingsAfterCompletion?.isProvisioningCompleted()).toBe(true);

    // ADR-0008 §3/§11, "Tests attendus" (amendement 1) : interroge JUSTE APRES l'emission de
    // ProvisioningCompleted (mais avant que quoi que ce soit ne le consomme — aucun consommateur
    // Outbox de cet evenement n'existe, voir docs/domain/events.md) -> resultat INCHANGE.
    expect(await resolveAccess(tenantId)).toBe('ACCESSIBLE');
  });

  it("crash apres CreateHealthFacility, avant StartTrialSubscription : acces refuse (Subscription absente), tenant intact ; la reprise complete tout le provisioning", async () => {
    const ownerUserId = await createOwner('saga-crash-owner');
    const tenantId = await createFacility('Etablissement Saga Crash', ownerUserId);

    expect(await resolveAccess(tenantId)).toBe('NOT_FOUND');
    const facility = await tenant.unitOfWork.withTransaction(
      () => tenant.repositories.healthFacilities.findByTenantId(TenantId.create(tenantId).getValue()),
      { tenantId: TenantId.create(tenantId).getValue() },
    );
    expect(facility?.isActive()).toBe(true);

    await runFullSaga(tenantId, ownerUserId);

    expect(await resolveAccess(tenantId)).toBe('ACCESSIBLE');
    const tenantIdVo = TenantId.create(tenantId).getValue();
    const settings = await tenant.unitOfWork.withTransaction(
      () => tenant.repositories.facilitySettings.findByTenantId(tenantIdVo),
      { tenantId: tenantIdVo },
    );
    expect(settings?.isProvisioningCompleted()).toBe(true);
  });

  it('rejeu de CHAQUE etape (redelivrance Outbox) : idempotent partout, aucun doublon (Subscription/membership/FacilitySettings/completion)', async () => {
    const ownerUserId = await createOwner('saga-replay-owner');
    const tenantId = await createFacility('Etablissement Saga Replay', ownerUserId);

    await runFullSaga(tenantId, ownerUserId);
    await runFullSaga(tenantId, ownerUserId);

    const subscriptionRows = await rawClient.query('SELECT id FROM "platform"."Subscription" WHERE tenant_id = $1', [tenantId]);
    expect(subscriptionRows.rowCount).toBe(1);

    const tenantIdVo = TenantId.create(tenantId).getValue();
    expect(await identity.unitOfWork.withTransaction(
      () => identity.repositories.memberships.countActive(tenantIdVo),
      { tenantId: tenantIdVo },
    )).toBe(1);
    const membership = await findMembership(tenantId, ownerUserId);
    expect(membership).not.toBeNull();

    // `FacilitySettings` est sous RLS FORCE (schema `public`, comme `HealthFacility`) : la requete
    // brute doit positionner `app.tenant_id` explicitement (meme discipline que rls.test.ts),
    // jamais une requete sans contexte qui ne verrait aucune ligne.
    await rawClient.query('BEGIN');
    let settingsRows;
    try {
      await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      settingsRows = await rawClient.query(
        'SELECT id, provisioning_completed_at FROM "FacilitySettings" WHERE tenant_id = $1',
        [tenantId],
      );
    } finally {
      await rawClient.query('COMMIT');
    }
    expect(settingsRows.rowCount).toBe(1);
    expect((settingsRows.rows[0] as { provisioning_completed_at: Date | null }).provisioning_completed_at).not.toBeNull();
  });

  it("le role ADMIN_ETABLISSEMENT accorde par la Saga n'est JAMAIS visible sur un autre tenant (test croise multi-tenant)", async () => {
    const ownerA = await createOwner('saga-cross-owner-a');
    const tenantA = await createFacility('Etablissement Saga Croise A', ownerA);
    const ownerB = await createOwner('saga-cross-owner-b');
    const tenantB = await createFacility('Etablissement Saga Croise B', ownerB);

    await subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(healthFacilityCreatedEnvelope(tenantA, ownerA));
    await identity.outboxHandlers.grantOwnerMembershipOnSubscriptionStarted(subscriptionStartedEnvelope(tenantA, ownerA));

    const membershipOnA = await findMembership(tenantA, ownerA);
    expect(membershipOnA).not.toBeNull();

    const tenantBVo = TenantId.create(tenantB).getValue();
    const ownerAVo = UserAccountId.create(ownerA).getValue();
    const membershipOnB = await identity.unitOfWork.withTransaction(
      () => identity.repositories.memberships.findActiveByUserAndTenant(ownerAVo, tenantBVo),
      { tenantId: tenantBVo },
    );
    expect(membershipOnB).toBeNull();
  });

  it('MembershipGranted ne peut JAMAIS preceder SubscriptionStarted (correctif F3) : HealthFacilityCreated relaye seul (SubscriptionStarted pas encore emis/consomme) ne cree AUCUN membership', async () => {
    const ownerUserId = await createOwner('saga-order-owner');
    const tenantId = await createFacility('Etablissement Saga Ordre', ownerUserId);

    // Seule la PREMIERE etape de la chaine resequencee est jouee ici (HealthFacilityCreated ->
    // StartTrialSubscription) — `identity.grantOwnerMembershipOnSubscriptionStarted` n'est
    // volontairement PAS invoque : reproduit fidelement un retard reel de la Saga (l'evenement
    // SubscriptionStarted n'a "pas encore ete consomme"). AVANT le correctif F3, le MEME
    // HealthFacilityCreated aurait deja suffi, seul, a accorder ADMIN_ETABLISSEMENT (branchage
    // parallele sur le meme eventType) — ce test prouve que ce n'est structurellement plus
    // possible : Identity ne consomme plus `tenant.health-facility.created` du tout.
    await subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(
      healthFacilityCreatedEnvelope(tenantId, ownerUserId),
    );

    // L'abonnement d'essai existe desormais (§3 : l'acces se derive de HealthFacility+Subscription)...
    const tenantIdVo = TenantId.create(tenantId).getValue();
    expect(await subscription.repositories.subscriptions.findByTenantId(tenantIdVo)).not.toBeNull();
    expect(await resolveAccess(tenantId)).toBe('ACCESSIBLE');

    // ...mais AUCUN membership : GrantMembership n'a jamais ete declenche, car son SEUL
    // declencheur desormais (`SubscriptionStarted`) n'a pas ete "consomme" dans ce scenario.
    const membership = await findMembership(tenantId, ownerUserId);
    expect(membership).toBeNull();

    // Reprise : SubscriptionStarted "consomme" a son tour -> le membership apparait ENFIN, jamais
    // avant.
    await identity.outboxHandlers.grantOwnerMembershipOnSubscriptionStarted(
      subscriptionStartedEnvelope(tenantId, ownerUserId),
    );
    expect(await findMembership(tenantId, ownerUserId)).not.toBeNull();
  });

  it("Subscription retardee (echec transitoire, ex. catalogue de plans non seede au premier passage) puis rejouee : la chaine complete (membership -> seed -> ProvisioningCompleted) ne se declenche qu_APRES le succes, jamais avant", async () => {
    const ownerUserId = await createOwner('saga-retry-owner');
    const tenantId = await createFacility('Etablissement Saga Retry', ownerUserId);

    // Simule l'ECHEC TRANSITOIRE du premier maillon (catalogue de plans non encore seede au
    // premier passage) SANS toucher au catalogue REEL partage par `beforeAll` (seede une seule
    // fois pour tout ce fichier, potentiellement utilise par d'autres suites executees en
    // parallele) : un handler dedie, construit avec des repositories Plan/PlanPrice EN MEMOIRE et
    // volontairement VIDES, reproduit fidelement `STANDARD_PLAN_NOT_FOUND` sur le VRAI
    // `SubscriptionRepository` Postgres du tenant.
    const emptyPlanRepository = new InMemoryPlanRepository();
    const emptyPlanPriceRepository = new InMemoryPlanPriceRepository();
    const transientlyFailingStartTrialSubscription = new StartTrialSubscriptionHandler(
      emptyPlanRepository,
      emptyPlanPriceRepository,
      subscription.repositories.subscriptions,
      subscription.unitOfWork,
      new SystemClock(),
      new UuidGenerator(),
      new InMemorySubscriptionAuditTrail(),
    );
    const transientlyFailingHandler = createStartTrialSubscriptionOnHealthFacilityCreatedHandler({
      startTrialSubscriptionHandler: transientlyFailingStartTrialSubscription,
    });

    await expect(
      transientlyFailingHandler(healthFacilityCreatedEnvelope(tenantId, ownerUserId)),
    ).rejects.toThrow(/STANDARD_PLAN_NOT_FOUND/);

    // Aucun abonnement -> par construction (F3), aucun membership, aucun acces, rien en aval.
    const tenantIdVo = TenantId.create(tenantId).getValue();
    expect(await subscription.repositories.subscriptions.findByTenantId(tenantIdVo)).toBeNull();
    expect(await findMembership(tenantId, ownerUserId)).toBeNull();
    expect(await resolveAccess(tenantId)).toBe('NOT_FOUND');
    const settingsBeforeRetry = await tenant.unitOfWork.withTransaction(
      () => tenant.repositories.facilitySettings.findByTenantId(tenantIdVo),
      { tenantId: tenantIdVo },
    );
    expect(settingsBeforeRetry).toBeNull();

    // "Rejeu" (at-least-once, ADR-0008 §5) : le VRAI consommateur, catalogue REELLEMENT seede par
    // `beforeAll`, reussit desormais — la chaine complete se declenche alors, jamais avant.
    await runFullSaga(tenantId, ownerUserId);

    expect(await subscription.repositories.subscriptions.findByTenantId(tenantIdVo)).not.toBeNull();
    expect(await findMembership(tenantId, ownerUserId)).not.toBeNull();
    expect(await resolveAccess(tenantId)).toBe('ACCESSIBLE');
    const settingsAfterRetry = await tenant.unitOfWork.withTransaction(
      () => tenant.repositories.facilitySettings.findByTenantId(tenantIdVo),
      { tenantId: tenantIdVo },
    );
    expect(settingsAfterRetry?.isProvisioningCompleted()).toBe(true);
  });
});
