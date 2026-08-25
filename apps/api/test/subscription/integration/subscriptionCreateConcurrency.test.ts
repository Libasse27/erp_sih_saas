import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Subscription } from '../../../src/modules/subscription/domain/Subscription.js';
import { PrismaPlanPriceRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanPriceRepository.js';
import { PrismaPlanRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanRepository.js';
import { PrismaSubscriptionRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaSubscriptionRepository.js';
import { seedPlanCatalog } from '../../../src/modules/subscription/infrastructure/seed/seedSubscriptionCatalog.js';
import { createRawPgClient, createTestPrismaClient, uniqueTenantId } from './dbTestHelpers.js';

/**
 * Adversarial : deux `Subscription` DISTINCTS (deux `id` differents) forces sur le MEME tenant —
 * simule un double-clic sur "demarrer l'essai gratuit" ou un retry client apres timeout reseau
 * (StartTrialSubscriptionHandler.execute() tourne entierement sous
 * unitOfWork.withTransaction(...), exactement comme ici). La contrainte UNIQUE `tenant_id`
 * (invariant "un tenant a exactement un abonnement actif a un instant donne") est la SEULE
 * barriere reelle.
 *
 * Pendant DIRECT de test/payment/integration/paymentProviderTransactionIdConcurrency.test.ts,
 * mais pour la branche CREATE de PrismaSubscriptionRepository.save() : les DEUX ecritures
 * partent SOUS DE VRAIES TRANSACTIONS Postgres (PgUnitOfWork.withTransaction), pas seulement
 * via save() nu — c'est justement DANS ce contexte transactionnel qu'un `create()` + catch
 * `P2002` etait structurellement casse avant correction (la violation de contrainte avorte la
 * transaction, la relecture de rattrapage echouait avec `25P02 current transaction is aborted`).
 * Bug reel decouvert par revue sur ce module, corrige par `createMany({ skipDuplicates: true })`
 * — voir le commentaire de PrismaSubscriptionRepository.save().
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees. `planId`/
 * `currentPlanPriceId` portent une contrainte FK vers le catalogue (`Plan`/`PlanPrice`) : le
 * catalogue doit donc etre seede avant de construire un `Subscription`, meme pour ce test qui ne
 * s'interesse qu'a la contrainte UNIQUE sur `tenant_id`.
 */
describe('Subscription — deux agregats DISTINCTS forces sur le MEME tenant, sous transaction reelle (contrainte UNIQUE, adversarial)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let subscriptionRepository: PrismaSubscriptionRepository;

  const tenantIdValue = uniqueTenantId();

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    subscriptionRepository = new PrismaSubscriptionRepository(prisma);

    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    await seedPlanCatalog(new PrismaPlanRepository(prisma), new PrismaPlanPriceRepository(prisma), clock, idGenerator);
  });

  afterAll(async () => {
    await rawClient.query('DELETE FROM "platform"."OutboxMessage" WHERE tenant_id = $1', [tenantIdValue]);
    await rawClient.query('DELETE FROM "platform"."Subscription" WHERE tenant_id = $1', [tenantIdValue]);
    await rawClient.end();
    await prisma.$disconnect();
  });

  it(
    'un seul appel a save() (sous transaction reelle) gagne, le perdant recoit NOTRE erreur explicite (jamais un 25P02 Postgres brut)',
    async () => {
      const clock = new SystemClock();
      const idGenerator = new UuidGenerator();
      const tenant = TenantId.create(tenantIdValue).getValue();

      const planRepository = new PrismaPlanRepository(prisma);
      const planPriceRepository = new PrismaPlanPriceRepository(prisma);
      const standardPlan = await planRepository.findByCode('STANDARD');
      if (standardPlan === null) {
        throw new Error('Catalogue introuvable apres seed (bug de test).');
      }
      const standardPrice = await planPriceRepository.findEffectivePrice(standardPlan.id, 'MENSUEL', clock.now());
      if (standardPrice === null) {
        throw new Error('Tarif MENSUEL introuvable apres seed (bug de test).');
      }

      const subscriptionA = Subscription.startTrial({
        tenantId: tenant,
        standardPlanId: standardPlan.id,
        standardPlanPriceId: standardPrice.id,
        clock,
        idGenerator,
      });
      const subscriptionB = Subscription.startTrial({
        tenantId: tenant,
        standardPlanId: standardPlan.id,
        standardPlanPriceId: standardPrice.id,
        clock,
        idGenerator,
      });
      expect(subscriptionA.id.toString()).not.toBe(subscriptionB.id.toString());

      const uowA = new PgUnitOfWork(prisma);
      const uowB = new PgUnitOfWork(prisma);
      const [resultA, resultB] = await Promise.allSettled([
        uowA.withTransaction(() => subscriptionRepository.save(subscriptionA, tenant), { tenantId: tenant }),
        uowB.withTransaction(() => subscriptionRepository.save(subscriptionB, tenant), { tenantId: tenant }),
      ]);

      const outcomes = [resultA, resultB];
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(rejected).toHaveLength(1);
      // Le perdant doit recevoir NOTRE erreur explicite (anomalie reelle, deux id distincts),
      // jamais une exception Postgres brute (`25P02`) qui signalerait que le rattrapage a tente
      // une requete dans une transaction deja avortee.
      expect(String(rejected[0]?.reason)).not.toMatch(/25P02|current transaction is aborted/);
      expect(rejected[0]?.reason).toBeInstanceOf(Error);

      const rows = await rawClient.query('SELECT id FROM "platform"."Subscription" WHERE tenant_id = $1', [
        tenantIdValue,
      ]);
      expect(rows.rowCount).toBe(1);
    },
  );
});
