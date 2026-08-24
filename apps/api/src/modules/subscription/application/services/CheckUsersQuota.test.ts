import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryPlanRepository,
  InMemorySubscriptionRepository,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/subscription/builders/testKit.js';
import { Plan } from '../../domain/Plan.js';
import { Subscription } from '../../domain/Subscription.js';
import { PlanLimits } from '../../domain/value-objects/PlanLimits.js';
import { PlanName } from '../../domain/value-objects/PlanName.js';
import { PlanPriceId } from '../../domain/value-objects/PlanPriceId.js';
import { CheckUsersQuotaHandler } from './CheckUsersQuota.js';

const TENANT_ID = uuidAt(1);

async function buildScenario(maxUsers: number) {
  const planRepository = new InMemoryPlanRepository();
  const subscriptionRepository = new InMemorySubscriptionRepository();
  const idGenerator = new SequentialIdGenerator();
  const clock = new FixedClock('2026-08-24T10:00:00Z');

  const plan = Plan.create({
    code: 'STANDARD',
    name: PlanName.create('Standard').getValue(),
    limits: PlanLimits.create(maxUsers, 20).getValue(),
    clock,
    idGenerator,
  });
  await planRepository.save(plan);

  const tenantId = TenantId.create(TENANT_ID).getValue();
  const subscription = Subscription.startTrial({
    tenantId,
    standardPlanId: plan.id,
    standardPlanPriceId: PlanPriceId.create(idGenerator.generate()).getValue(),
    clock,
    idGenerator,
  });
  await subscriptionRepository.save(subscription, tenantId);

  const handler = new CheckUsersQuotaHandler(subscriptionRepository, planRepository);
  return { handler, planRepository, subscriptionRepository };
}

describe('CheckUsersQuotaHandler', () => {
  it('rapporte withinLimit=true quand le nombre de memberships actifs ne depasse pas maxUsers', async () => {
    const { handler } = await buildScenario(10);
    const result = await handler.execute({ tenantId: TENANT_ID, activeMembershipsCount: 10 });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue()).toEqual({ withinLimit: true, maxUsers: 10, activeMembershipsCount: 10 });
  });

  it('rapporte withinLimit=false en cas de depassement, SANS lever d_exception (alerte, jamais blocage — O-02.4)', async () => {
    const { handler } = await buildScenario(10);
    const result = await handler.execute({ tenantId: TENANT_ID, activeMembershipsCount: 11 });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().withinLimit).toBe(false);
    expect(result.getValue().maxUsers).toBe(10);
    expect(result.getValue().activeMembershipsCount).toBe(11);
  });

  it('rejette un tenantId invalide', async () => {
    const { handler } = await buildScenario(10);
    const result = await handler.execute({ tenantId: 'not-a-uuid', activeMembershipsCount: 1 });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_TENANT_ID');
  });

  it('echoue si le tenant ne possede aucun abonnement', async () => {
    const { handler } = await buildScenario(10);
    const result = await handler.execute({ tenantId: uuidAt(999), activeMembershipsCount: 1 });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('SUBSCRIPTION_NOT_FOUND');
  });

  it('echoue si le forfait de l_abonnement est introuvable dans le catalogue (incoherence de donnees)', async () => {
    const { subscriptionRepository } = await buildScenario(10);
    // Simule une incoherence : le forfait a ete supprime du catalogue (ne devrait jamais arriver
    // en pratique, catalogue seed immuable) sans supprimer l'abonnement qui le reference —
    // reutilise le meme `subscriptionRepository` (deja seed avec l'abonnement) mais un
    // `PlanRepository` vide.
    const emptyPlanRepository = new InMemoryPlanRepository();
    const handlerWithEmptyCatalog = new CheckUsersQuotaHandler(subscriptionRepository, emptyPlanRepository);

    const result = await handlerWithEmptyCatalog.execute({ tenantId: TENANT_ID, activeMembershipsCount: 1 });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('PLAN_NOT_FOUND');
  });
});
