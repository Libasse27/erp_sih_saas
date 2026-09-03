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
 * Garde-fou d'unicite concurrente : deux `Subscription` DISTINCTS (deux `id` differents, generes
 * aleatoirement — jamais derives du `tenantId`) construits pour le MEME tenant, sauvegardes SOUS
 * DE VRAIES TRANSACTIONS Postgres concurrentes (PgUnitOfWork.withTransaction, exactement comme
 * StartTrialSubscriptionHandler.execute()).
 *
 * `PrismaSubscriptionRepository.save()` ne recoit et ne peut recevoir aucune information sur la
 * PROVENANCE de l'appel (retry legitime de la Saga de provisioning, un autre appelant applicatif
 * concurrent, deux workers Outbox sur le meme evenement, etc.) — seule la couche appelante
 * (StartTrialSubscriptionHandler, via `findByTenantId` avant ecriture) porte cette distinction.
 * Ce que CE repository garantit, et TOUT ce qu'il peut garantir avec les seules informations
 * disponibles a son niveau, c'est l'invariant `UNIQUE(tenant_id)` : quelle que soit la source de
 * la concurrence, deux ecritures concurrentes pour le meme tenant ne produisent JAMAIS deux lignes
 * — le perdant de la course se voit renvoyer un succes idempotent (`fulfilled`), jamais une
 * exception (voir le commentaire de `PrismaSubscriptionRepository.save()`).
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
describe('Subscription — deux agregats DISTINCTS sur le MEME tenant, sous transaction reelle (garde-fou UNIQUE(tenant_id))', () => {
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
    'deux appels concurrents a save() (sous transaction reelle) : les DEUX reussissent (idempotence cote appelant), une SEULE Subscription persistee pour le tenant',
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
        ownerUserId: idGenerator.generate(),
        clock,
        idGenerator,
      });
      const subscriptionB = Subscription.startTrial({
        tenantId: tenant,
        standardPlanId: standardPlan.id,
        standardPlanPriceId: standardPrice.id,
        ownerUserId: idGenerator.generate(),
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

      // 2 fulfilled ne signifie PAS 2 Subscription creees : le perdant de la course recoit un
      // succes idempotent (voir PrismaSubscriptionRepository.save()), jamais une exception — ni la
      // notre, ni un `25P02` Postgres brut qui signalerait une requete tentee dans une transaction
      // deja avortee (bug reel corrige, voir docstring de describe() ci-dessus). La seule ligne
      // persistee est verifiee juste apres : c'est ELLE, pas le statut des promesses, qui prouve
      // l'invariant `UNIQUE(tenant_id)`.
      const outcomes = [resultA, resultB];
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(0);

      const rows = await rawClient.query('SELECT id FROM "platform"."Subscription" WHERE tenant_id = $1', [
        tenantIdValue,
      ]);
      expect(rows.rowCount).toBe(1);
    },
  );
});
