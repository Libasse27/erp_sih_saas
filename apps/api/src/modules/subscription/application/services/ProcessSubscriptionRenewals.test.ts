import { describe, expect, it } from 'vitest';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryPlanPriceRepository,
  InMemoryPlanRepository,
  InMemorySubscriptionRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/subscription/builders/testKit.js';
import { Plan } from '../../domain/Plan.js';
import { PlanPrice } from '../../domain/PlanPrice.js';
import { Subscription } from '../../domain/Subscription.js';
import { PlanLimits } from '../../domain/value-objects/PlanLimits.js';
import { PlanName } from '../../domain/value-objects/PlanName.js';
import { ProcessSubscriptionRenewalsHandler } from './ProcessSubscriptionRenewals.js';
import { createReactivateSubscriptionOnPaymentSucceededHandler } from './ReactivateSubscriptionOnPaymentSucceeded.js';

const CATALOG_CLOCK = new FixedClock('2026-01-01T00:00:00Z');
const TENANT = TenantId.create(uuidAt(1)).getValue();

async function seedStandardPlan(planRepository: InMemoryPlanRepository, planPriceRepository: InMemoryPlanPriceRepository) {
  const idGenerator = new SequentialIdGenerator();
  const plan = Plan.create({
    code: 'STANDARD',
    name: PlanName.create('STANDARD').getValue(),
    limits: PlanLimits.create(10, 20).getValue(),
    clock: CATALOG_CLOCK,
    idGenerator,
  });
  await planRepository.save(plan);
  const price = PlanPrice.create({
    planId: plan.id,
    amount: Money.fromXOF(35_000).getValue(),
    period: 'MENSUEL',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    clock: CATALOG_CLOCK,
    idGenerator,
  });
  await planPriceRepository.save(price);
  return { plan, price };
}

/**
 * Suite d'integration applicative (repositories in-memory) — couvre les scenarios adversariaux :
 * "absence totale de webhook" (le scheduler doit rester autonome), "paiement du renouvellement
 * d'une periode d'essai" et "concurrence scheduler vs webhook" (independance de l'ordre).
 */
describe('ProcessSubscriptionRenewalsHandler — scheduler autonome (O-25.6)', () => {
  it(
    'ABSENCE TOTALE DE WEBHOOK : le scheduler declenche seul grace (a l_echeance) -> mode degrade (J+7) -> maintien signale (J+37), sans AUCUN Payment/webhook',
    async () => {
      const planRepository = new InMemoryPlanRepository();
      const planPriceRepository = new InMemoryPlanPriceRepository();
      const subscriptionRepository = new InMemorySubscriptionRepository();
      const unitOfWork = new InMemoryUnitOfWork();
      const clock = new FixedClock('2026-08-01T00:00:00Z');
      const idGenerator = new SequentialIdGenerator();

      const { plan, price } = await seedStandardPlan(planRepository, planPriceRepository);
      const subscription = Subscription.startTrial({
        tenantId: TENANT,
        standardPlanId: plan.id,
        standardPlanPriceId: price.id,
        clock,
        idGenerator,
      });
      await subscriptionRepository.save(subscription, TENANT);

      const handler = new ProcessSubscriptionRenewalsHandler(subscriptionRepository, planPriceRepository, unitOfWork, clock, idGenerator);

      // J+0 (echeance atteinte, 2026-08-31 = trialEndsAt) : grace IMMEDIATE.
      clock.advanceTo('2026-08-31T00:00:00Z');
      let result = await handler.execute();
      expect(result.renewalsDue).toBe(1);
      expect(result.gracePeriodsStarted).toBe(1);
      let stored = await subscriptionRepository.findByTenantId(TENANT);
      expect(stored?.status).toBe('GRACE_PERIOD');

      // Avant J+7 : aucune transition.
      clock.advanceTo('2026-09-06T23:59:59Z');
      result = await handler.execute();
      expect(result.degradedModeEntries).toBe(0);
      stored = await subscriptionRepository.findByTenantId(TENANT);
      expect(stored?.status).toBe('GRACE_PERIOD');

      // J+7 : mode degrade, TOUJOURS sans aucun Payment/webhook.
      clock.advanceTo('2026-09-07T00:00:00Z');
      result = await handler.execute();
      expect(result.degradedModeEntries).toBe(1);
      stored = await subscriptionRepository.findByTenantId(TENANT);
      expect(stored?.status).toBe('DEGRADED');

      // J+37 (J+7 + 30 jours) : maintien indefini signale UNE fois.
      clock.advanceTo('2026-10-07T00:00:00Z');
      result = await handler.execute();
      expect(result.degradedModeSustainedNotifications).toBe(1);
      stored = await subscriptionRepository.findByTenantId(TENANT);
      expect(stored?.status).toBe('DEGRADED'); // maintien indefini, pas de nouvelle transition

      // Un cycle ulterieur ne re-signale plus (idempotence du scheduler).
      clock.advanceTo('2026-11-07T00:00:00Z');
      result = await handler.execute();
      expect(result.degradedModeSustainedNotifications).toBe(0);
    },
  );

  it('PAIEMENT DU RENOUVELLEMENT D_UNE PERIODE D_ESSAI : la fin d_essai suit exactement le meme chemin qu_un renouvellement payant', async () => {
    const planRepository = new InMemoryPlanRepository();
    const planPriceRepository = new InMemoryPlanPriceRepository();
    const subscriptionRepository = new InMemorySubscriptionRepository();
    const unitOfWork = new InMemoryUnitOfWork();
    const clock = new FixedClock('2026-08-01T00:00:00Z');
    const idGenerator = new SequentialIdGenerator();

    const { plan, price } = await seedStandardPlan(planRepository, planPriceRepository);
    const subscription = Subscription.startTrial({ tenantId: TENANT, standardPlanId: plan.id, standardPlanPriceId: price.id, clock, idGenerator });
    await subscriptionRepository.save(subscription, TENANT);
    expect(subscription.status).toBe('TRIALING');

    const renewalsHandler = new ProcessSubscriptionRenewalsHandler(subscriptionRepository, planPriceRepository, unitOfWork, clock, idGenerator);
    clock.advanceTo('2026-08-31T00:00:00Z'); // trialEndsAt
    await renewalsHandler.execute();
    let stored = await subscriptionRepository.findByTenantId(TENANT);
    expect(stored?.status).toBe('GRACE_PERIOD');

    // Paiement confirme PENDANT la grace (avant J+7) — meme mecanisme de reactivation qu_un
    // abonnement payant standard, aucune branche "conversion d_essai" separee.
    const reactivateHandler = createReactivateSubscriptionOnPaymentSucceededHandler({
      subscriptionRepository,
      unitOfWork,
      clock,
      idGenerator,
    });
    await reactivateHandler({
      id: 'evt-1',
      eventType: 'payment.payment.saas-payment-succeeded',
      eventVersion: 1,
      aggregateId: 'payment-id',
      tenantId: TENANT.toString(),
      occurredAt: new Date('2026-09-02T00:00:00Z'),
      payload: {
        tenantId: TENANT.toString(),
        subscriptionId: subscription.id.toString(),
        newPeriodStartsAt: '2026-08-31T00:00:00Z',
        newPeriodEndsAt: '2026-09-30T00:00:00Z',
      },
    });

    stored = await subscriptionRepository.findByTenantId(TENANT);
    expect(stored?.status).toBe('ACTIVE');
    expect(stored?.trialEndsAt).toBeNull();
    expect(stored?.periodEndsAt).toEqual(new Date('2026-09-30T00:00:00Z'));
  });

  it(
    'CONCURRENCE SCHEDULER VS WEBHOOK : resultat final identique quel que soit l_ordre d_execution effectif (scheduler avant webhook, ou webhook avant scheduler)',
    async () => {
      async function runScenario(order: 'scheduler-first' | 'webhook-first') {
        const planRepository = new InMemoryPlanRepository();
        const planPriceRepository = new InMemoryPlanPriceRepository();
        const subscriptionRepository = new InMemorySubscriptionRepository();
        const unitOfWork = new InMemoryUnitOfWork();
        const clock = new FixedClock('2026-09-30T00:00:00Z'); // instant precis de l_echeance
        const idGenerator = new SequentialIdGenerator();

        const { plan, price } = await seedStandardPlan(planRepository, planPriceRepository);
        const subscription = Subscription.startTrial({
          tenantId: TENANT,
          standardPlanId: plan.id,
          standardPlanPriceId: price.id,
          clock: new FixedClock('2026-08-01T00:00:00Z'),
          idGenerator,
        });
        // Simule un abonnement deja payant, ACTIVE, dont l_echeance tombe exactement "maintenant".
        subscription.renew({
          newPeriodStartsAt: new Date('2026-08-31T00:00:00Z'),
          newPeriodEndsAt: new Date('2026-09-30T00:00:00Z'),
          clock: new FixedClock('2026-08-31T00:00:00Z'),
          idGenerator,
        });
        await subscriptionRepository.save(subscription, TENANT);

        const renewalsHandler = new ProcessSubscriptionRenewalsHandler(subscriptionRepository, planPriceRepository, unitOfWork, clock, idGenerator);
        const reactivateHandler = createReactivateSubscriptionOnPaymentSucceededHandler({
          subscriptionRepository,
          unitOfWork,
          clock,
          idGenerator,
        });
        const paymentEnvelope = {
          id: 'evt-race',
          eventType: 'payment.payment.saas-payment-succeeded',
          eventVersion: 1,
          aggregateId: 'payment-id',
          tenantId: TENANT.toString(),
          occurredAt: clock.now(),
          payload: {
            tenantId: TENANT.toString(),
            subscriptionId: subscription.id.toString(),
            newPeriodStartsAt: '2026-09-30T00:00:00Z',
            newPeriodEndsAt: '2026-10-30T00:00:00Z',
          },
        };

        if (order === 'scheduler-first') {
          await renewalsHandler.execute();
          await reactivateHandler(paymentEnvelope);
        } else {
          await reactivateHandler(paymentEnvelope);
          await renewalsHandler.execute();
        }

        return subscriptionRepository.findByTenantId(TENANT);
      }

      const schedulerFirst = await runScenario('scheduler-first');
      const webhookFirst = await runScenario('webhook-first');

      // Meme etat final, quel que soit l_ordre effectif d_execution.
      expect(schedulerFirst?.status).toBe('ACTIVE');
      expect(webhookFirst?.status).toBe('ACTIVE');
      expect(schedulerFirst?.periodEndsAt).toEqual(new Date('2026-10-30T00:00:00Z'));
      expect(webhookFirst?.periodEndsAt).toEqual(new Date('2026-10-30T00:00:00Z'));
      expect(schedulerFirst?.gracePeriodStartedAt).toBeNull();
      expect(webhookFirst?.gracePeriodStartedAt).toBeNull();
    },
  );
});
