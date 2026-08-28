import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import type { OutboxEventEnvelope } from '../../../src/shared-kernel/application/OutboxEventHandler.js';
import { buildTenantModule, type TenantModule } from '../../../src/modules/tenant/infrastructure/TenantModule.js';
import type { UserAccountExistenceChecker } from '../../../src/modules/tenant/application/ports/UserAccountExistenceChecker.js';
import { buildSubscriptionModule, seedPlanCatalog, type SubscriptionModule } from '../../../src/modules/subscription/infrastructure/SubscriptionModule.js';
import { PrismaUserAccountRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserAccountRepository.js';
import { UserAccount } from '../../../src/modules/identity/domain/UserAccount.js';
import { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { Email } from '../../../src/modules/identity/domain/value-objects/Email.js';
import { PasswordHash } from '../../../src/modules/identity/domain/value-objects/PasswordHash.js';
import { uniqueEmail, uniqueFacilityName } from '../../identity/integration/dbTestHelpers.js';
import { createRawPgClient, createTestPrismaClient } from './dbTestHelpers.js';

/**
 * Preuve d'integration reelle (PostgreSQL) de la premiere etape chorographiee de la Saga de
 * provisioning (ADR-0008 §1/§4, Phase 0 etape 10/13) : `subscription.startTrialSubscriptionOnHealthFacilityCreated`,
 * consommateur Outbox de `HealthFacilityCreated`, invoque DIRECTEMENT (sans passer par le relais
 * BullMQ reel — deja adversarialement teste par `test/shared-kernel/integration/outboxRelay.test.ts`
 * et `outboxIdempotency.test.ts`, etape 6). Ce test se concentre sur ce que CE consommateur doit
 * garantir PAR LUI-MEME (idempotence de deuxieme niveau, cf. docs/domain/events.md), pas sur le
 * relais generique.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('StartTrialSubscriptionOnHealthFacilityCreated — consommateur Outbox reel (ADR-0008 §1/§4/§5)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let tenant: TenantModule;
  let subscription: SubscriptionModule;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    // Reproduit fidelement `IdentityModuleBackedUserAccountExistenceChecker` de
    // composition-root.ts (ADR-0008 §9, amendement 1) — instance DEDIEE de
    // `PrismaUserAccountRepository`, meme discipline "duplique plutot qu'importe" que les autres
    // tests d'integration de ce depot.
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
    tenant = buildTenantModule({ prisma, clock: new SystemClock(), idGenerator: new UuidGenerator(), userAccountExistenceChecker });
    subscription = buildSubscriptionModule({ prisma, clock: new SystemClock(), idGenerator: new UuidGenerator() });
    await seedPlanCatalog(subscription.repositories.plans, subscription.repositories.planPrices, new SystemClock(), new UuidGenerator());
  });

  afterAll(async () => {
    await rawClient.end();
    await prisma.$disconnect();
  });

  /** Provisionne un `UserAccount` reel (module Identity) pour servir d'`ownerUserId` (ADR-0008 §9, amendement 1) — necessaire depuis que `CreateHealthFacilityCommand.ownerUserId` doit correspondre a un compte REELLEMENT EXISTANT. */
  async function createOwnerUserId(): Promise<string> {
    const userAccounts = new PrismaUserAccountRepository(prisma);
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const account = UserAccount.register({
      email: Email.create(uniqueEmail('saga-owner')).getValue(),
      passwordHash: PasswordHash.fromHash('fake-hash-for-tests-only').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await userAccounts.save(account);
    return account.id.toString();
  }

  async function createFacility(): Promise<{ tenantId: string; ownerUserId: string }> {
    const ownerUserId = await createOwnerUserId();
    const result = await tenant.handlers.createHealthFacility.execute({
      name: uniqueFacilityName('Etablissement Saga Provisioning'),
      ownerUserId,
    });
    if (result.isFailure()) {
      throw new Error(`Echec creation etablissement: ${result.getError()}`);
    }
    return { tenantId: result.getValue().tenantId, ownerUserId };
  }

  /** `ownerUserId` (ADR-0008 §9, resequencement F3) : desormais LU par le consommateur depuis le payload — jamais omis ici. */
  function envelopeFor(tenantId: string, ownerUserId: string): OutboxEventEnvelope {
    return {
      id: `outbox-msg-${tenantId}`,
      eventType: 'tenant.health-facility.created',
      eventVersion: 1,
      aggregateId: tenantId,
      tenantId,
      occurredAt: new Date('2026-08-28T09:00:00Z'),
      payload: { name: 'Etablissement Saga Provisioning', ownerUserId },
    };
  }

  it(
    "'crash' avant StartTrialSubscription : aucun Subscription n'existe encore, puis la reprise (invocation du consommateur) complete le provisioning sans toucher au HealthFacility",
    async () => {
      const { tenantId, ownerUserId } = await createFacility();

      const beforeRows = await rawClient.query('SELECT id FROM "platform"."Subscription" WHERE tenant_id = $1', [tenantId]);
      expect(beforeRows.rowCount).toBe(0);

      await subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(envelopeFor(tenantId, ownerUserId));

      const afterRows = await rawClient.query(
        'SELECT status FROM "platform"."Subscription" WHERE tenant_id = $1',
        [tenantId],
      );
      expect(afterRows.rowCount).toBe(1);
      expect((afterRows.rows[0] as { status: string }).status).toBe('TRIALING');

      // `HealthFacility` est sous RLS FORCE (schema `public`) : la relecture doit passer par le
      // repository, sous un contexte transactionnel qui positionne `app.tenant_id` (jamais une
      // requete SQL brute, qui ne verrait aucune ligne — voir PrismaHealthFacilityRepository.ts).
      const tenantIdVo = TenantId.create(tenantId).getValue();
      const facility = await tenant.unitOfWork.withTransaction(
        () => tenant.repositories.healthFacilities.findByTenantId(tenantIdVo),
        { tenantId: tenantIdVo },
      );
      expect(facility?.isActive()).toBe(true);
    },
  );

  it('redelivrance SEQUENTIELLE du meme evenement (at-least-once) : SUBSCRIPTION_ALREADY_EXISTS traite comme succes, aucun doublon, aucune exception', async () => {
    const { tenantId, ownerUserId } = await createFacility();
    const envelope = envelopeFor(tenantId, ownerUserId);

    await expect(subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(envelope)).resolves.toBeUndefined();
    await expect(subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(envelope)).resolves.toBeUndefined();

    const rows = await rawClient.query('SELECT id FROM "platform"."Subscription" WHERE tenant_id = $1', [tenantId]);
    expect(rows.rowCount).toBe(1);
  });

  it('deux "workers" concurrents sur le MEME evenement : un seul Subscription cree, aucune exception non geree ne remonte (contrainte UNIQUE tenant_id en dernier ressort)', async () => {
    const { tenantId, ownerUserId } = await createFacility();
    const envelope = envelopeFor(tenantId, ownerUserId);

    const outcomes = await Promise.allSettled([
      subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(envelope),
      subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(envelope),
    ]);

    // Les DEUX doivent reussir du point de vue de la Saga : le perdant de la course recoit
    // SUBSCRIPTION_ALREADY_EXISTS (Result.failure metier), traite comme un succes idempotent par
    // le consommateur — jamais une exception qui ferait echouer le message Outbox correspondant.
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('fulfilled');
    }

    const rows = await rawClient.query('SELECT id FROM "platform"."Subscription" WHERE tenant_id = $1', [tenantId]);
    expect(rows.rowCount).toBe(1);
  });

  it("leve une erreur explicite (jamais silencieuse) si tenantId est absent de l'enveloppe", async () => {
    const { tenantId, ownerUserId } = await createFacility();
    const envelope: OutboxEventEnvelope = { ...envelopeFor(tenantId, ownerUserId), tenantId: null };

    await expect(subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(envelope)).rejects.toThrow();

    const rows = await rawClient.query('SELECT id FROM "platform"."Subscription" WHERE tenant_id = $1', [tenantId]);
    expect(rows.rowCount).toBe(0);
  });

  it("leve une erreur explicite (jamais silencieuse) si ownerUserId est absent du payload (ADR-0008 §9, resequencement F3) — jamais une identite devinee", async () => {
    const { tenantId } = await createFacility();
    const envelope: OutboxEventEnvelope = {
      id: `outbox-msg-${tenantId}`,
      eventType: 'tenant.health-facility.created',
      eventVersion: 1,
      aggregateId: tenantId,
      tenantId,
      occurredAt: new Date('2026-08-28T09:00:00Z'),
      payload: { name: 'Etablissement Saga Provisioning' },
    };

    await expect(subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated(envelope)).rejects.toThrow();

    const rows = await rawClient.query('SELECT id FROM "platform"."Subscription" WHERE tenant_id = $1', [tenantId]);
    expect(rows.rowCount).toBe(0);
  });
});
