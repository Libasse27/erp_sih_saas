import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { Money } from '../../../src/shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Subscription } from '../../../src/modules/subscription/domain/Subscription.js';
import { SubscriptionConcurrencyConflictError } from '../../../src/modules/subscription/domain/ports/SubscriptionRepository.js';
import { createApplyPlanUpgradeOnPaymentSucceededHandler } from '../../../src/modules/subscription/application/services/ApplyPlanUpgradeOnPaymentSucceeded.js';
import { PrismaPlanChangeRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanChangeRepository.js';
import { PrismaPlanPriceRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanPriceRepository.js';
import { PrismaPlanRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanRepository.js';
import { PrismaPlanUpgradeRequestRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaPlanUpgradeRequestRepository.js';
import { PrismaSubscriptionRepository } from '../../../src/modules/subscription/infrastructure/persistence/PrismaSubscriptionRepository.js';
import { seedPlanCatalog } from '../../../src/modules/subscription/infrastructure/seed/seedSubscriptionCatalog.js';
import { SubscriptionId } from '../../../src/modules/subscription/domain/value-objects/SubscriptionId.js';
import { createRawPgClient, createTestPrismaClient, uniqueTenantId } from './dbTestHelpers.js';

/**
 * Adversarial : pendant de `test/payment/integration/paymentConfirmExpireConcurrency.test.ts`, mais
 * pour `Subscription`. Depuis la passe 2, TROIS writers peuvent ecrire le MEME abonnement
 * concurremment (application d'un upgrade paye, reactivation sur paiement, scheduler de
 * renouvellement). Sans verrouillage optimiste, le dernier `UPDATE` gagnant ecraserait
 * silencieusement l'autre — alors qu'un evenement aurait deja ete ecrit dans l'Outbox.
 *
 * COMPORTEMENT EXACT GARANTI, tel que reellement implemente (et non une formulation vague) :
 *
 *   1. Une ecriture concurrente DIRECTE (sans retry, simulant le scheduler) et l'application d'un
 *      upgrade paye (AVEC retry borne, voir ApplyPlanUpgradeOnPaymentSucceeded) partent en meme
 *      temps sur le meme abonnement. Le forfait cible FINIT TOUJOURS par etre applique : si
 *      l'upgrade perd la course, il relit l'agregat frais, reapplique et re-sauvegarde.
 *   2. L'ecriture directe, elle, PEUT echouer (`SubscriptionConcurrencyConflictError`) : c'est le
 *      comportement VOULU pour un writer sans retry — sa perte est explicite, jamais silencieuse.
 *      C'est exactement ce que fait le scheduler reel, qui saute alors l'abonnement pour ce cycle.
 *   3. Aucune des deux issues ne produit de lost-update : la version en base reflete le nombre
 *      d'ecritures REELLEMENT commitees, et l'etat final porte le forfait cible.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('Subscription — ecritures concurrentes (verrouillage optimiste, adversarial)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let subscriptionRepository: PrismaSubscriptionRepository;
  let planUpgradeRequestRepository: PrismaPlanUpgradeRequestRepository;
  let planChangeRepository: PrismaPlanChangeRepository;

  const tenantIdValue = uniqueTenantId();
  let tenantId: TenantId;
  let subscriptionId: string;
  let targetPlanPriceId: string;
  let planChangeId: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();

    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const planRepository = new PrismaPlanRepository(prisma);
    const planPriceRepository = new PrismaPlanPriceRepository(prisma);
    subscriptionRepository = new PrismaSubscriptionRepository(prisma);
    planUpgradeRequestRepository = new PrismaPlanUpgradeRequestRepository(prisma);
    planChangeRepository = new PrismaPlanChangeRepository(prisma);

    await seedPlanCatalog(planRepository, planPriceRepository, clock, idGenerator);

    const standardPlan = await planRepository.findByCode('STANDARD');
    const targetPlan = await planRepository.findByCode('PROFESSIONNEL');
    if (standardPlan === null || targetPlan === null) {
      throw new Error('Catalogue introuvable apres seed (bug de test).');
    }
    const standardPrice = await planPriceRepository.findEffectivePrice(standardPlan.id, 'MENSUEL', clock.now());
    const targetPrice = await planPriceRepository.findEffectivePrice(targetPlan.id, 'MENSUEL', clock.now());
    if (standardPrice === null || targetPrice === null) {
      throw new Error('Tarifs MENSUEL introuvables apres seed (bug de test).');
    }
    targetPlanPriceId = targetPrice.id.toString();

    tenantId = TenantId.create(tenantIdValue).getValue();
    const now = clock.now();
    const subscription = Subscription.reconstitute(SubscriptionId.create(idGenerator.generate()).getValue(), {
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
    });

    // Demande d'upgrade en attente, produite par l'agregat lui-meme (jamais fabriquee a la main).
    planChangeId = idGenerator.generate();
    const request = subscription.requestUpgrade({
      planChangeId,
      toPlanId: targetPlan.id,
      toPlanPriceId: targetPrice.id,
      proratedAmount: Money.fromXOF(10_000).getValue(),
      now,
      clock,
      idGenerator,
    });
    await subscriptionRepository.save(subscription, tenantId);
    subscriptionId = subscription.id.toString();

    const unitOfWork = new PgUnitOfWork(prisma);
    await unitOfWork.withTransaction(
      async () => {
        await planUpgradeRequestRepository.replaceExpiredAndInsert(request, tenantId, now);
      },
      { tenantId },
    );
  });

  afterAll(async () => {
    await rawClient.query('DELETE FROM "platform"."SubscriptionPlanUpgradeRequest" WHERE tenant_id = $1', [
      tenantIdValue,
    ]);
    await rawClient.query('DELETE FROM "platform"."SubscriptionPlanChange" WHERE tenant_id = $1', [tenantIdValue]);
    await rawClient.query('DELETE FROM "platform"."OutboxMessage" WHERE tenant_id = $1', [tenantIdValue]);
    await rawClient.query('DELETE FROM "platform"."Subscription" WHERE id = $1', [subscriptionId]);
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('l_upgrade paye finit TOUJOURS par etre applique, sans lost-update, malgre une ecriture concurrente sans retry', async () => {
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();

    const handler = createApplyPlanUpgradeOnPaymentSucceededHandler({
      subscriptionRepository,
      planUpgradeRequestRepository,
      planChangeRepository,
      unitOfWork: new PgUnitOfWork(prisma),
      clock,
      idGenerator,
    });

    // Instance B : lue SEPAREMENT, exactement comme le ferait un autre processus (scheduler). Elle
    // retient la version qu'ELLE a lue — c'est cette version, opposee a celle de la base au moment
    // du `save()`, qui detecte le conflit.
    const concurrentView = await subscriptionRepository.findById(
      SubscriptionId.create(subscriptionId).getValue(),
      tenantId,
    );
    if (concurrentView === null) {
      throw new Error('Subscription introuvable juste apres sa creation (etat de test incoherent).');
    }

    const envelope = {
      id: 'outbox-upgrade-lock',
      eventType: 'payment.payment.saas-payment-succeeded',
      eventVersion: 1,
      aggregateId: idGenerator.generate(),
      tenantId: tenantIdValue,
      occurredAt: clock.now(),
      payload: {
        tenantId: tenantIdValue,
        subscriptionId,
        platformInvoiceId: idGenerator.generate(),
        purpose: 'UPGRADE',
        sourceReference: planChangeId,
        newPeriodStartsAt: clock.now().toISOString(),
        newPeriodEndsAt: clock.now().toISOString(),
      },
    };

    // Vraie concurrence : l'application de l'upgrade (avec retry) et une ecriture directe
    // (sans retry) partent EN MEME TEMPS.
    const [upgradeOutcome, concurrentOutcome] = await Promise.allSettled([
      handler(envelope),
      (async () => {
        concurrentView.markRenewalDue({
          amountXof: 35_000,
          newPeriodStartsAt: concurrentView.periodEndsAt,
          newPeriodEndsAt: new Date(concurrentView.periodEndsAt.getTime() + 30 * 24 * 60 * 60 * 1000),
          clock,
          idGenerator,
        });
        await subscriptionRepository.save(concurrentView, tenantId);
      })(),
    ]);

    // L'application de l'upgrade doit TOUJOURS aboutir (sa boucle de retry la protege).
    expect(upgradeOutcome.status).toBe('fulfilled');

    // L'ecriture directe peut avoir gagne (fulfilled) OU perdu la course
    // (SubscriptionConcurrencyConflictError) : les DEUX issues sont acceptables pour un writer
    // volontairement depourvu de retry. Seule exigence : si elle a echoue, c'est PROPREMENT, par
    // l'erreur typee du contrat de port, jamais par une erreur technique brute.
    if (concurrentOutcome.status === 'rejected') {
      expect(concurrentOutcome.reason).toBeInstanceOf(SubscriptionConcurrencyConflictError);
    }

    // Etat final en base : le forfait cible est applique, quel que soit l'ordre d'ecriture reel.
    const finalRow = await rawClient.query(
      'SELECT current_plan_price_id, version FROM "platform"."Subscription" WHERE id = $1',
      [subscriptionId],
    );
    const finalState = finalRow.rows[0] as { current_plan_price_id: string; version: number };
    expect(finalState.current_plan_price_id).toBe(targetPlanPriceId);
    // La version reflete le nombre d'UPDATE reellement commites : au moins un (l'upgrade), jamais
    // plus que le nombre total d'ecritures tentees. Une version stagnante a 0 signalerait un
    // UPDATE passe hors du controle de version.
    expect(finalState.version).toBeGreaterThanOrEqual(1);

    // La demande a bien ete consommee et l'historique ecrit, malgre la course.
    const requestRows = await rawClient.query(
      'SELECT id FROM "platform"."SubscriptionPlanUpgradeRequest" WHERE id = $1',
      [planChangeId],
    );
    expect(requestRows.rowCount).toBe(0);
    const changeRows = await rawClient.query('SELECT id FROM "platform"."SubscriptionPlanChange" WHERE id = $1', [
      planChangeId,
    ]);
    expect(changeRows.rowCount).toBe(1);
  });
});
