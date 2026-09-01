import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Subscription } from '../../../src/modules/subscription/domain/Subscription.js';
import { UpgradeSubscriptionPlanHandler } from '../../../src/modules/subscription/application/commands/UpgradeSubscriptionPlan.js';
import { PrismaPlanPriceRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanPriceRepository.js';
import { PrismaPlanRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanRepository.js';
import { PrismaPlanUpgradeRequestRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanUpgradeRequestRepository.js';
import { PrismaSubscriptionRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaSubscriptionRepository.js';
import { seedPlanCatalog } from '../../../src/modules/subscription/infrastructure/seed/seedSubscriptionCatalog.js';
import { SubscriptionId } from '../../../src/modules/subscription/domain/value-objects/SubscriptionId.js';
import { createRawPgClient, createTestPrismaClient, uniqueTenantId } from './dbTestHelpers.js';
import { InMemorySubscriptionAuditTrail } from '../builders/testKit.js';

/**
 * Adversarial : DOUBLE SOUMISSION d'une demande d'upgrade (double-clic, requete rejouee par un
 * client sur reseau instable — contexte ouest-africain, §6.3). Les deux appels a
 * `UpgradeSubscriptionPlanHandler.execute()` partent EN MEME TEMPS sur le MEME abonnement.
 *
 * La contrainte UNIQUE `subscription_id` de `platform.SubscriptionPlanUpgradeRequest` (migration
 * 20260825090000) est la SEULE barriere reelle ici — aucune verification applicative prealable ne
 * pourrait trancher cette course. Ce test prouve qu'il n'en resulte JAMAIS deux demandes (et donc
 * jamais deux factures d'upgrade pour un seul changement de forfait), et que l'appel perdant echoue
 * PROPREMENT avec `UPGRADE_ALREADY_PENDING` plutot que par une erreur technique remontee brute.
 *
 * Verifie aussi le point central de la passe 2 : meme apres deux demandes, le forfait de
 * l'abonnement n'a PAS bouge — aucun paiement n'a encore ete confirme.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('PlanUpgradeRequest — double soumission concurrente (contrainte UNIQUE, adversarial)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let handler: UpgradeSubscriptionPlanHandler;
  let subscriptionRepository: PrismaSubscriptionRepository;

  const tenantIdValue = uniqueTenantId();
  let subscriptionId: string;
  let standardPriceId: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();

    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const planRepository = new PrismaPlanRepository(prisma);
    const planPriceRepository = new PrismaPlanPriceRepository(prisma);
    subscriptionRepository = new PrismaSubscriptionRepository(prisma);
    const planUpgradeRequestRepository = new PrismaPlanUpgradeRequestRepository(prisma);
    const unitOfWork = new PgUnitOfWork(prisma);

    await seedPlanCatalog(planRepository, planPriceRepository, clock, idGenerator);

    const standardPlan = await planRepository.findByCode('STANDARD');
    if (standardPlan === null) {
      throw new Error('Catalogue STANDARD introuvable apres seed (bug de test).');
    }
    const standardPrice = await planPriceRepository.findEffectivePrice(standardPlan.id, 'MENSUEL', clock.now());
    if (standardPrice === null) {
      throw new Error('Tarif MENSUEL STANDARD introuvable apres seed (bug de test).');
    }
    standardPriceId = standardPrice.id.toString();

    const tenantId = TenantId.create(tenantIdValue).getValue();
    // Abonnement ACTIVE dont la periode est EN COURS : seule situation ouvrant droit a un upgrade
    // proratise (decision produit). `periodEndsAt` volontairement loin dans le futur pour que le
    // prorata soit strictement positif quelle que soit la date reelle d'execution du test.
    const now = clock.now();
    const subscription = Subscription.reconstitute(
      SubscriptionId.create(idGenerator.generate()).getValue(),
      {
        tenantId,
        planId: standardPlan.id,
        currentPlanPriceId: standardPrice.id,
        period: 'MENSUEL',
        status: 'ACTIVE',
        trialEndsAt: null,
        periodStartsAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
        periodEndsAt: new Date(now.getTime() + 25 * 24 * 60 * 60 * 1000),
        createdAt: now,
        gracePeriodStartedAt: null,
        degradedModeEnteredAt: null,
        degradedModeSustainedNotifiedAt: null,
      },
    );
    await subscriptionRepository.save(subscription, tenantId);
    subscriptionId = subscription.id.toString();

    handler = new UpgradeSubscriptionPlanHandler(
      planRepository,
      planPriceRepository,
      subscriptionRepository,
      planUpgradeRequestRepository,
      unitOfWork,
      clock,
      idGenerator,
      new InMemorySubscriptionAuditTrail(),
    );
  });

  afterAll(async () => {
    await rawClient.query('DELETE FROM "platform"."SubscriptionPlanUpgradeRequest" WHERE tenant_id = $1', [
      tenantIdValue,
    ]);
    await rawClient.query('DELETE FROM "platform"."OutboxMessage" WHERE tenant_id = $1', [tenantIdValue]);
    await rawClient.query('DELETE FROM "platform"."Subscription" WHERE id = $1', [subscriptionId]);
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('deux demandes CONCURRENTES sur le meme abonnement : exactement UNE ligne survit, l_autre echoue avec UPGRADE_ALREADY_PENDING', async () => {
    const [first, second] = await Promise.allSettled([
      handler.execute({ tenantId: tenantIdValue, targetPlanCode: 'PROFESSIONNEL' }),
      handler.execute({ tenantId: tenantIdValue, targetPlanCode: 'COMPLET' }),
    ]);

    // Aucun des deux appels ne doit remonter d'exception : le perdant echoue par un `Result`
    // metier explicite, jamais par une erreur technique brute (P2002) laissee fuir.
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');

    const outcomes = [first, second]
      .filter((settled): settled is PromiseFulfilledResult<Awaited<ReturnType<typeof handler.execute>>> =>
        settled.status === 'fulfilled',
      )
      .map((settled) => settled.value);

    const successes = outcomes.filter((result) => result.isSuccess());
    const failures = outcomes.filter((result) => result.isFailure());
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.getError()).toBe('UPGRADE_ALREADY_PENDING');

    const rows = await rawClient.query(
      'SELECT id FROM "platform"."SubscriptionPlanUpgradeRequest" WHERE subscription_id = $1',
      [subscriptionId],
    );
    expect(rows.rowCount).toBe(1);
    expect((rows.rows[0] as { id: string }).id).toBe(successes[0]?.getValue().planChangeId);

    // Le forfait n'a PAS change : une demande n'est pas une application (tout l'objet de la passe 2).
    const subscriptionRow = await rawClient.query(
      'SELECT current_plan_price_id FROM "platform"."Subscription" WHERE id = $1',
      [subscriptionId],
    );
    expect((subscriptionRow.rows[0] as { current_plan_price_id: string }).current_plan_price_id).toBe(
      standardPriceId,
    );
  });
});
