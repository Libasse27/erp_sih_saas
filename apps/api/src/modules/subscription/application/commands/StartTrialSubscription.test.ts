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
import { PlanLimits } from '../../domain/value-objects/PlanLimits.js';
import { PlanName } from '../../domain/value-objects/PlanName.js';
import { StartTrialSubscriptionHandler } from './StartTrialSubscription.js';

const TENANT_ID = uuidAt(1);
const OWNER_USER_ID = uuidAt(500);

async function seedStandardPlan(planRepository: InMemoryPlanRepository, planPriceRepository: InMemoryPlanPriceRepository) {
  const clock = new FixedClock('2026-01-01T00:00:00Z');
  const idGenerator = new SequentialIdGenerator();
  const plan = Plan.create({
    code: 'STANDARD',
    name: PlanName.create('Standard').getValue(),
    limits: PlanLimits.create(10, 20).getValue(),
    clock,
    idGenerator,
  });
  await planRepository.save(plan);

  const price = PlanPrice.create({
    planId: plan.id,
    amount: Money.fromXOF(35_000).getValue(),
    period: 'MENSUEL',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    clock,
    idGenerator,
  });
  await planPriceRepository.save(price);

  return { plan, price };
}

function buildHandler() {
  const planRepository = new InMemoryPlanRepository();
  const planPriceRepository = new InMemoryPlanPriceRepository();
  const subscriptionRepository = new InMemorySubscriptionRepository();
  const unitOfWork = new InMemoryUnitOfWork();
  const handler = new StartTrialSubscriptionHandler(
    planRepository,
    planPriceRepository,
    subscriptionRepository,
    unitOfWork,
    new FixedClock('2026-08-24T10:00:00Z'),
    new SequentialIdGenerator(),
  );
  return { planRepository, planPriceRepository, subscriptionRepository, unitOfWork, handler };
}

describe('StartTrialSubscriptionHandler', () => {
  it('demarre un essai STANDARD de 30 jours et le persiste', async () => {
    const { planRepository, planPriceRepository, subscriptionRepository, handler } = buildHandler();
    await seedStandardPlan(planRepository, planPriceRepository);

    const result = await handler.execute({ tenantId: TENANT_ID, ownerUserId: OWNER_USER_ID });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().trialEndsAt).toBe('2026-09-23T10:00:00.000Z');

    const saved = await subscriptionRepository.findByTenantId(TenantId.create(TENANT_ID).getValue());
    expect(saved).not.toBeNull();
    expect(saved?.status).toBe('TRIALING');
    expect(saved?.period).toBe('MENSUEL');
  });

  it('propage fidelement ownerUserId dans SubscriptionStarted (ADR-0008 §9, resequencement F3) — jamais un identifiant relu ou deduit d_ailleurs', async () => {
    const { planRepository, planPriceRepository, subscriptionRepository, handler } = buildHandler();
    await seedStandardPlan(planRepository, planPriceRepository);

    const result = await handler.execute({ tenantId: TENANT_ID, ownerUserId: OWNER_USER_ID });
    expect(result.isSuccess()).toBe(true);

    const events = subscriptionRepository.publishedEvents.filter((e) => e.eventType === 'subscription.subscription.started');
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { ownerUserId: string }).ownerUserId).toBe(OWNER_USER_ID);
  });

  it('positionne le contexte RLS (UnitOfWorkContext.tenantId) sur le tenant de la commande', async () => {
    const { planRepository, planPriceRepository, unitOfWork, handler } = buildHandler();
    await seedStandardPlan(planRepository, planPriceRepository);

    const result = await handler.execute({ tenantId: TENANT_ID, ownerUserId: OWNER_USER_ID });

    expect(result.isSuccess()).toBe(true);
    expect(unitOfWork.lastContext?.tenantId?.toString()).toBe(TENANT_ID);
  });

  it('rejette un tenantId invalide', async () => {
    const { handler } = buildHandler();
    const result = await handler.execute({ tenantId: 'not-a-uuid', ownerUserId: OWNER_USER_ID });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_TENANT_ID');
  });

  it('refuse de demarrer un second essai si un abonnement existe deja pour ce tenant', async () => {
    const { planRepository, planPriceRepository, handler } = buildHandler();
    await seedStandardPlan(planRepository, planPriceRepository);

    const first = await handler.execute({ tenantId: TENANT_ID, ownerUserId: OWNER_USER_ID });
    expect(first.isSuccess()).toBe(true);

    const second = await handler.execute({ tenantId: TENANT_ID, ownerUserId: OWNER_USER_ID });
    expect(second.isFailure()).toBe(true);
    expect(second.getError()).toBe('SUBSCRIPTION_ALREADY_EXISTS');
  });

  it('echoue si le forfait STANDARD est absent du catalogue (catalogue non seed)', async () => {
    const { handler } = buildHandler();
    const result = await handler.execute({ tenantId: TENANT_ID, ownerUserId: OWNER_USER_ID });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('STANDARD_PLAN_NOT_FOUND');
  });

  it('echoue si le forfait STANDARD n_a aucun tarif MENSUEL effectif', async () => {
    const { planRepository, handler } = buildHandler();
    const plan = Plan.create({
      code: 'STANDARD',
      name: PlanName.create('Standard').getValue(),
      limits: PlanLimits.create(10, 20).getValue(),
      clock: new FixedClock('2026-01-01T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    await planRepository.save(plan);

    const result = await handler.execute({ tenantId: TENANT_ID, ownerUserId: OWNER_USER_ID });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('STANDARD_PLAN_PRICE_NOT_FOUND');
  });
});
