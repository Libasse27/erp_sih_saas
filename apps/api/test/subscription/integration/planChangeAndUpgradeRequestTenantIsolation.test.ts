import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { Money } from '../../../src/shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Subscription } from '../../../src/modules/subscription/domain/Subscription.js';
import { PlanChange } from '../../../src/modules/subscription/domain/PlanChange.js';
import { PlanUpgradeRequest } from '../../../src/modules/subscription/domain/PlanUpgradeRequest.js';
import { PrismaPlanPriceRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanPriceRepository.js';
import { PrismaPlanRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanRepository.js';
import { PrismaSubscriptionRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaSubscriptionRepository.js';
import { PrismaPlanChangeRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanChangeRepository.js';
import { PrismaPlanUpgradeRequestRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanUpgradeRequestRepository.js';
import { seedPlanCatalog } from '../../../src/modules/subscription/infrastructure/seed/seedSubscriptionCatalog.js';
import { PlanChangeId } from '../../../src/modules/subscription/domain/value-objects/PlanChangeId.js';
import { SubscriptionId } from '../../../src/modules/subscription/domain/value-objects/SubscriptionId.js';
import { createRawPgClient, createTestPrismaClient, uniqueTenantId } from './dbTestHelpers.js';

/**
 * Pendant de test/subscription/integration/subscriptionRepositoryTenantIsolation.test.ts pour
 * `SubscriptionPlanChange`/`SubscriptionPlanUpgradeRequest` (Phase 0, etape 12/13, sweep
 * d'isolation multi-tenant) — MEME regime que `Subscription` : schema `platform`, AUCUNE
 * politique RLS (ADR-0001 §3.3), isolation PUREMENT APPLICATIVE. Prouve, pour ces deux entites
 * jusqu'ici non couvertes :
 *   - lecture croisee : `findById`/`findBySubscriptionId`/`listBySubscriptionId` d'une ligne du
 *     tenant A interrogee avec le tenant B ne la renvoient jamais, meme avec un identifiant valide ;
 *   - ecriture croisee : la garde explicite `if (!x.tenantId.equals(tenantId)) throw` de
 *     `PrismaPlanChangeRepository.append()` (~ligne 52) et
 *     `PrismaPlanUpgradeRequestRepository.replaceExpiredAndInsert()` (~ligne 88) intercepte toute
 *     tentative d'ecrire un agregat du tenant A sous un contexte tenant B, AVANT toute requete —
 *     aucune ligne n'est jamais ecrite.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('PlanChange/PlanUpgradeRequest — isolation inter-tenant (schema platform, sans RLS)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let planRepository: PrismaPlanRepository;
  let planPriceRepository: PrismaPlanPriceRepository;
  let subscriptionRepository: PrismaSubscriptionRepository;
  let planChangeRepository: PrismaPlanChangeRepository;
  let planUpgradeRequestRepository: PrismaPlanUpgradeRequestRepository;

  const clock = new SystemClock();
  const idGenerator = new UuidGenerator();
  const tenantAId = uniqueTenantId();
  const tenantBId = uniqueTenantId();
  let subscriptionAId: string;
  let subscriptionBId: string;
  let planChangeAId: string;
  let planChangeBId: string;
  let upgradeRequestAId: string;
  let upgradeRequestBId: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    planRepository = new PrismaPlanRepository(prisma);
    planPriceRepository = new PrismaPlanPriceRepository(prisma);
    subscriptionRepository = new PrismaSubscriptionRepository(prisma);
    planChangeRepository = new PrismaPlanChangeRepository(prisma);
    planUpgradeRequestRepository = new PrismaPlanUpgradeRequestRepository(prisma);

    await seedPlanCatalog(planRepository, planPriceRepository, clock, idGenerator);

    const standardPlan = await planRepository.findByCode('STANDARD');
    const proPlan = await planRepository.findByCode('PROFESSIONNEL');
    if (standardPlan === null || proPlan === null) {
      throw new Error('Catalogue STANDARD/PROFESSIONNEL introuvable apres seed (bug de test).');
    }
    const standardPrice = await planPriceRepository.findEffectivePrice(standardPlan.id, 'MENSUEL', clock.now());
    const proPrice = await planPriceRepository.findEffectivePrice(proPlan.id, 'MENSUEL', clock.now());
    if (standardPrice === null || proPrice === null) {
      throw new Error('Tarif MENSUEL STANDARD/PROFESSIONNEL introuvable apres seed (bug de test).');
    }

    const tenantA = TenantId.create(tenantAId).getValue();
    const tenantB = TenantId.create(tenantBId).getValue();

    const subscriptionA = Subscription.startTrial({
      tenantId: tenantA,
      standardPlanId: standardPlan.id,
      standardPlanPriceId: standardPrice.id,
      ownerUserId: idGenerator.generate(),
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
      ownerUserId: idGenerator.generate(),
      clock,
      idGenerator,
    });
    subscriptionB.pullDomainEvents();
    await subscriptionRepository.save(subscriptionB, tenantB);
    subscriptionBId = subscriptionB.id.toString();

    const planChangeA = PlanChange.create({
      id: PlanChangeId.create(idGenerator.generate()).getValue(),
      subscriptionId: subscriptionA.id,
      tenantId: tenantA,
      changeType: 'UPGRADE',
      fromPlanId: standardPlan.id,
      fromPlanPriceId: standardPrice.id,
      toPlanId: proPlan.id,
      toPlanPriceId: proPrice.id,
      proratedAmount: Money.fromXOF(5_000).getValue(),
      requestedAt: clock.now(),
      platformInvoiceId: null,
      clock,
    });
    await planChangeRepository.append(planChangeA, tenantA);
    planChangeAId = planChangeA.id.toString();

    const planChangeB = PlanChange.create({
      id: PlanChangeId.create(idGenerator.generate()).getValue(),
      subscriptionId: subscriptionB.id,
      tenantId: tenantB,
      changeType: 'UPGRADE',
      fromPlanId: standardPlan.id,
      fromPlanPriceId: standardPrice.id,
      toPlanId: proPlan.id,
      toPlanPriceId: proPrice.id,
      proratedAmount: Money.fromXOF(5_000).getValue(),
      requestedAt: clock.now(),
      platformInvoiceId: null,
      clock,
    });
    await planChangeRepository.append(planChangeB, tenantB);
    planChangeBId = planChangeB.id.toString();

    const now = clock.now();
    const coveredPeriodEndsAt = new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000);
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const upgradeRequestA = PlanUpgradeRequest.create(PlanChangeId.create(idGenerator.generate()).getValue(), {
      subscriptionId: subscriptionA.id,
      tenantId: tenantA,
      fromPlanId: standardPlan.id,
      fromPlanPriceId: standardPrice.id,
      toPlanId: proPlan.id,
      toPlanPriceId: proPrice.id,
      proratedAmount: Money.fromXOF(3_000).getValue(),
      coveredPeriodStartsAt: now,
      coveredPeriodEndsAt,
      requestedAt: now,
      expiresAt,
    });
    await planUpgradeRequestRepository.replaceExpiredAndInsert(upgradeRequestA, tenantA, now);
    upgradeRequestAId = upgradeRequestA.id.toString();

    const upgradeRequestB = PlanUpgradeRequest.create(PlanChangeId.create(idGenerator.generate()).getValue(), {
      subscriptionId: subscriptionB.id,
      tenantId: tenantB,
      fromPlanId: standardPlan.id,
      fromPlanPriceId: standardPrice.id,
      toPlanId: proPlan.id,
      toPlanPriceId: proPrice.id,
      proratedAmount: Money.fromXOF(3_000).getValue(),
      coveredPeriodStartsAt: now,
      coveredPeriodEndsAt,
      requestedAt: now,
      expiresAt,
    });
    await planUpgradeRequestRepository.replaceExpiredAndInsert(upgradeRequestB, tenantB, now);
    upgradeRequestBId = upgradeRequestB.id.toString();
  });

  afterAll(async () => {
    await rawClient.query('DELETE FROM "platform"."SubscriptionPlanUpgradeRequest" WHERE tenant_id = ANY($1)', [
      [tenantAId, tenantBId],
    ]);
    await rawClient.query('DELETE FROM "platform"."SubscriptionPlanChange" WHERE tenant_id = ANY($1)', [
      [tenantAId, tenantBId],
    ]);
    await rawClient.query('DELETE FROM "platform"."OutboxMessage" WHERE tenant_id = ANY($1)', [[tenantAId, tenantBId]]);
    await rawClient.query('DELETE FROM "platform"."Subscription" WHERE id = ANY($1)', [
      [subscriptionAId, subscriptionBId],
    ]);
    await rawClient.end();
    await prisma.$disconnect();
  });

  describe('PlanChange — lecture croisee', () => {
    it("findById(planChangeA, tenantB) renvoie null : un id valide d'un AUTRE tenant ne suffit jamais", async () => {
      const tenantB = TenantId.create(tenantBId).getValue();
      const result = await planChangeRepository.findById(planChangeAId, tenantB);
      expect(result).toBeNull();
    });

    it('findById(planChangeA, tenantA) retrouve bien la ligne du proprietaire legitime', async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const result = await planChangeRepository.findById(planChangeAId, tenantA);
      expect(result?.id.toString()).toBe(planChangeAId);
    });

    it(
      "listBySubscriptionId(subscriptionA, tenantB) ne renvoie RIEN, meme en fournissant l'id de subscription exact " +
        "d'un autre tenant",
      async () => {
        const tenantB = TenantId.create(tenantBId).getValue();
        const result = await planChangeRepository.listBySubscriptionId(
          SubscriptionId.create(subscriptionAId).getValue(),
          tenantB,
        );
        expect(result).toHaveLength(0);
      },
    );

    it('listBySubscriptionId(subscriptionA, tenantA) retrouve bien la ligne du proprietaire legitime', async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const result = await planChangeRepository.listBySubscriptionId(
        SubscriptionId.create(subscriptionAId).getValue(),
        tenantA,
      );
      expect(result.map((change) => change.id.toString())).toEqual([planChangeAId]);
    });

    it("findById(planChangeB, tenantA) renvoie null (symetrique)", async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const result = await planChangeRepository.findById(planChangeBId, tenantA);
      expect(result).toBeNull();
    });
  });

  describe('PlanChange — ecriture croisee (garde applicative de append())', () => {
    it(
      "append(rogueChange appartenant au tenant A, tenantB) leve une erreur AVANT toute requete et n'ecrit AUCUNE " +
        'ligne (PrismaPlanChangeRepository.ts ~ligne 52)',
      async () => {
        const tenantA = TenantId.create(tenantAId).getValue();
        const tenantB = TenantId.create(tenantBId).getValue();
        const standardPlan = await planRepository.findByCode('STANDARD');
        const proPlan = await planRepository.findByCode('PROFESSIONNEL');
        if (standardPlan === null || proPlan === null) {
          throw new Error('Catalogue introuvable (bug de test).');
        }
        const standardPrice = await planPriceRepository.findEffectivePrice(standardPlan.id, 'MENSUEL', clock.now());
        const proPrice = await planPriceRepository.findEffectivePrice(proPlan.id, 'MENSUEL', clock.now());
        if (standardPrice === null || proPrice === null) {
          throw new Error('Tarif introuvable (bug de test).');
        }

        const rogueChange = PlanChange.create({
          id: PlanChangeId.create(idGenerator.generate()).getValue(),
          subscriptionId: SubscriptionId.create(subscriptionAId).getValue(),
          tenantId: tenantA,
          changeType: 'UPGRADE',
          fromPlanId: standardPlan.id,
          fromPlanPriceId: standardPrice.id,
          toPlanId: proPlan.id,
          toPlanPriceId: proPrice.id,
          proratedAmount: Money.fromXOF(1_000).getValue(),
          requestedAt: clock.now(),
          platformInvoiceId: null,
          clock,
        });

        await expect(planChangeRepository.append(rogueChange, tenantB)).rejects.toThrow(
          "Tentative d'ajout d'un PlanChange hors du tenant du contexte courant.",
        );

        const foundUnderCorrectTenant = await planChangeRepository.findById(rogueChange.id.toString(), tenantA);
        expect(foundUnderCorrectTenant).toBeNull();

        const rows = await rawClient.query('SELECT id FROM "platform"."SubscriptionPlanChange" WHERE id = $1', [
          rogueChange.id.toString(),
        ]);
        expect(rows.rowCount).toBe(0);
      },
    );
  });

  describe('PlanUpgradeRequest — lecture croisee', () => {
    it("findBySubscriptionId(subscriptionA, tenantB) renvoie null, meme avec l'id de subscription exact d'un autre tenant", async () => {
      const tenantB = TenantId.create(tenantBId).getValue();
      const result = await planUpgradeRequestRepository.findBySubscriptionId(
        SubscriptionId.create(subscriptionAId).getValue(),
        tenantB,
      );
      expect(result).toBeNull();
    });

    it('findBySubscriptionId(subscriptionA, tenantA) retrouve bien la demande du proprietaire legitime', async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const result = await planUpgradeRequestRepository.findBySubscriptionId(
        SubscriptionId.create(subscriptionAId).getValue(),
        tenantA,
      );
      expect(result?.id.toString()).toBe(upgradeRequestAId);
    });

    it("findById(upgradeRequestA, tenantB) renvoie null : un id valide d'un AUTRE tenant ne suffit jamais", async () => {
      const tenantB = TenantId.create(tenantBId).getValue();
      const result = await planUpgradeRequestRepository.findById(upgradeRequestAId, tenantB);
      expect(result).toBeNull();
    });

    it('findById(upgradeRequestA, tenantA) retrouve bien la demande du proprietaire legitime', async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const result = await planUpgradeRequestRepository.findById(upgradeRequestAId, tenantA);
      expect(result?.id.toString()).toBe(upgradeRequestAId);
    });

    it("findById(upgradeRequestB, tenantA) renvoie null (symetrique)", async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const result = await planUpgradeRequestRepository.findById(upgradeRequestBId, tenantA);
      expect(result).toBeNull();
    });
  });

  describe('PlanUpgradeRequest — ecriture croisee (garde applicative de replaceExpiredAndInsert())', () => {
    it(
      "replaceExpiredAndInsert(rogueRequest appartenant au tenant A, tenantB) leve une erreur AVANT toute requete et " +
        "n'ecrit AUCUNE ligne (PrismaPlanUpgradeRequestRepository.ts ~ligne 88)",
      async () => {
        const tenantA = TenantId.create(tenantAId).getValue();
        const tenantB = TenantId.create(tenantBId).getValue();
        const standardPlan = await planRepository.findByCode('STANDARD');
        const proPlan = await planRepository.findByCode('PROFESSIONNEL');
        if (standardPlan === null || proPlan === null) {
          throw new Error('Catalogue introuvable (bug de test).');
        }
        const standardPrice = await planPriceRepository.findEffectivePrice(standardPlan.id, 'MENSUEL', clock.now());
        const proPrice = await planPriceRepository.findEffectivePrice(proPlan.id, 'MENSUEL', clock.now());
        if (standardPrice === null || proPrice === null) {
          throw new Error('Tarif introuvable (bug de test).');
        }

        const now = clock.now();
        // Un `subscriptionId` INEDIT (jamais utilise par `upgradeRequestA`/`upgradeRequestB`) : la
        // table impose `@@unique([subscriptionId])`, et cette contrainte ne doit jamais etre ce qui
        // bloque l'insertion ici — c'est la garde applicative, et elle seule, qui doit intervenir,
        // AVANT que la contrainte n'ait la moindre chance de jouer.
        const rogueRequest = PlanUpgradeRequest.create(PlanChangeId.create(idGenerator.generate()).getValue(), {
          subscriptionId: SubscriptionId.create(randomUUID()).getValue(),
          tenantId: tenantA,
          fromPlanId: standardPlan.id,
          fromPlanPriceId: standardPrice.id,
          toPlanId: proPlan.id,
          toPlanPriceId: proPrice.id,
          proratedAmount: Money.fromXOF(1_000).getValue(),
          coveredPeriodStartsAt: now,
          coveredPeriodEndsAt: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000),
          requestedAt: now,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        });

        await expect(
          planUpgradeRequestRepository.replaceExpiredAndInsert(rogueRequest, tenantB, now),
        ).rejects.toThrow("Tentative d'ecriture d'une PlanUpgradeRequest hors du tenant du contexte courant.");

        const foundUnderCorrectTenant = await planUpgradeRequestRepository.findById(rogueRequest.id.toString(), tenantA);
        expect(foundUnderCorrectTenant).toBeNull();

        const rows = await rawClient.query(
          'SELECT id FROM "platform"."SubscriptionPlanUpgradeRequest" WHERE id = $1',
          [rogueRequest.id.toString()],
        );
        expect(rows.rowCount).toBe(0);
      },
    );
  });

  describe('ABSENCE DE RLS — contraste deliberement demontre (ADR-0001 §3.3)', () => {
    it('une requete SQL brute SANS filtre tenant_id expose les DEUX tenants sur SubscriptionPlanChange', async () => {
      const result = await rawClient.query(
        'SELECT tenant_id FROM "platform"."SubscriptionPlanChange" WHERE id = ANY($1)',
        [[planChangeAId, planChangeBId]],
      );
      const tenantIdsVisible = result.rows.map((row: { tenant_id: string }) => row.tenant_id);
      expect(tenantIdsVisible).toEqual(expect.arrayContaining([tenantAId, tenantBId]));
    });

    it('une requete SQL brute SANS filtre tenant_id expose les DEUX tenants sur SubscriptionPlanUpgradeRequest', async () => {
      const result = await rawClient.query(
        'SELECT tenant_id FROM "platform"."SubscriptionPlanUpgradeRequest" WHERE id = ANY($1)',
        [[upgradeRequestAId, upgradeRequestBId]],
      );
      const tenantIdsVisible = result.rows.map((row: { tenant_id: string }) => row.tenant_id);
      expect(tenantIdsVisible).toEqual(expect.arrayContaining([tenantAId, tenantBId]));
    });
  });
});
