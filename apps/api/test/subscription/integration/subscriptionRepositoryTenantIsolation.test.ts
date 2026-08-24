import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Subscription } from '../../../src/modules/subscription/domain/Subscription.js';
import { PrismaPlanPriceRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanPriceRepository.js';
import { PrismaPlanRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanRepository.js';
import { PrismaSubscriptionRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaSubscriptionRepository.js';
import { seedPlanCatalog } from '../../../src/modules/subscription/infrastructure/seed/seedSubscriptionCatalog.js';
import { SubscriptionId } from '../../../src/modules/subscription/domain/value-objects/SubscriptionId.js';
import { createRawPgClient, createTestPrismaClient, uniqueTenantId } from './dbTestHelpers.js';

/**
 * Test le plus important de cette etape (Phase 0, etape 4/13), pendant de
 * test/tenant/integration/rls.test.ts pour une table SANS RLS. `Subscription` vit dans le
 * schema `platform` (ADR-0001 §3.3) : AUCUNE politique RLS ne protege cette table (voir
 * migration 20260824090000_subscription_plan_pricing_init). Le premier bloc de tests
 * (`REPOSITORY`) prouve que `PrismaSubscriptionRepository` LUI-MEME ne renvoie jamais une ligne
 * appartenant a un autre tenant, meme interroge avec un `tenantId` different du proprietaire
 * reel — c'est la SEULE barriere reelle ici. Le second bloc (`ABSENCE DE RLS`) prouve, par
 * contraste, qu'un contournement du repository (SQL brut, sans filtre applicatif) expose bel et
 * bien les deux tenants : la protection n'est PAS un effet de bord du moteur, elle depend
 * entierement de la discipline du code applicatif — c'est precisement pourquoi le premier bloc
 * doit exister.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('Subscription — isolation inter-tenant (schema platform, sans RLS)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let planRepository: PrismaPlanRepository;
  let planPriceRepository: PrismaPlanPriceRepository;
  let subscriptionRepository: PrismaSubscriptionRepository;

  const tenantAId = uniqueTenantId();
  const tenantBId = uniqueTenantId();
  let subscriptionAId: string;
  let subscriptionBId: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    planRepository = new PrismaPlanRepository(prisma);
    planPriceRepository = new PrismaPlanPriceRepository(prisma);
    subscriptionRepository = new PrismaSubscriptionRepository(prisma);

    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    await seedPlanCatalog(planRepository, planPriceRepository, clock, idGenerator);

    const standardPlan = await planRepository.findByCode('STANDARD');
    if (standardPlan === null) {
      throw new Error('Catalogue STANDARD introuvable apres seed (bug de test).');
    }
    const standardPrice = await planPriceRepository.findEffectivePrice(standardPlan.id, 'MENSUEL', clock.now());
    if (standardPrice === null) {
      throw new Error('Tarif MENSUEL STANDARD introuvable apres seed (bug de test).');
    }

    const tenantA = TenantId.create(tenantAId).getValue();
    const tenantB = TenantId.create(tenantBId).getValue();

    const subscriptionA = Subscription.startTrial({
      tenantId: tenantA,
      standardPlanId: standardPlan.id,
      standardPlanPriceId: standardPrice.id,
      clock,
      idGenerator,
    });
    subscriptionA.pullDomainEvents();
    await subscriptionRepository.save(subscriptionA, tenantA);
    subscriptionAId = subscriptionA.id.toString();

    const subscriptionB = Subscription.startTrial({
      tenantId: tenantB,
      standardPlanId: standardPlan.id,
      standardPlanPriceId: standardPrice.id,
      clock,
      idGenerator,
    });
    subscriptionB.pullDomainEvents();
    await subscriptionRepository.save(subscriptionB, tenantB);
    subscriptionBId = subscriptionB.id.toString();
  });

  afterAll(async () => {
    await rawClient.query('DELETE FROM "platform"."Subscription" WHERE id = $1 OR id = $2', [
      subscriptionAId,
      subscriptionBId,
    ]);
    await rawClient.end();
    await prisma.$disconnect();
  });

  describe('REPOSITORY — PrismaSubscriptionRepository filtre explicitement par tenantId', () => {
    it("findById(subscriptionA, tenantB) renvoie null : un id valide d'un AUTRE tenant ne suffit jamais", async () => {
      const tenantB = TenantId.create(tenantBId).getValue();
      const subscriptionA = SubscriptionId.create(subscriptionAId).getValue();

      const result = await subscriptionRepository.findById(subscriptionA, tenantB);
      expect(result).toBeNull();
    });

    it("findById(subscriptionB, tenantA) renvoie null (symetrique)", async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const subscriptionB = SubscriptionId.create(subscriptionBId).getValue();

      const result = await subscriptionRepository.findById(subscriptionB, tenantA);
      expect(result).toBeNull();
    });

    it('findById(subscriptionA, tenantA) retrouve bien la ligne du proprietaire legitime', async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const subscriptionA = SubscriptionId.create(subscriptionAId).getValue();

      const result = await subscriptionRepository.findById(subscriptionA, tenantA);
      expect(result).not.toBeNull();
      expect(result?.id.toString()).toBe(subscriptionAId);
    });

    it("findByTenantId(tenantA) ne renvoie JAMAIS l'abonnement du tenant B, meme s'il existe en base", async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const result = await subscriptionRepository.findByTenantId(tenantA);
      expect(result?.id.toString()).toBe(subscriptionAId);
      expect(result?.id.toString()).not.toBe(subscriptionBId);
    });

    it("findByTenantId(tenantB) ne renvoie JAMAIS l'abonnement du tenant A", async () => {
      const tenantB = TenantId.create(tenantBId).getValue();
      const result = await subscriptionRepository.findByTenantId(tenantB);
      expect(result?.id.toString()).toBe(subscriptionBId);
      expect(result?.id.toString()).not.toBe(subscriptionAId);
    });
  });

  describe('ABSENCE DE RLS — contraste deliberement demontre (ADR-0001 §3.3)', () => {
    it("une requete SQL brute SANS filtre tenant_id expose les DEUX tenants (aucun moteur ne bloque, contrairement au schema public — voir tenant/rls.test.ts)", async () => {
      const result = await rawClient.query('SELECT tenant_id FROM "platform"."Subscription" WHERE id = ANY($1)', [
        [subscriptionAId, subscriptionBId],
      ]);
      const tenantIdsVisible = result.rows.map((row: { tenant_id: string }) => row.tenant_id);
      expect(tenantIdsVisible).toEqual(expect.arrayContaining([tenantAId, tenantBId]));
    });
  });
});
