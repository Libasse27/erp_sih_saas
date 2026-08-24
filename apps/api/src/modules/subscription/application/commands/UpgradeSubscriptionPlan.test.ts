import { describe, expect, it } from 'vitest';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryPlanChangeRepository,
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
import type { PlanCode } from '../../domain/value-objects/PlanCode.js';
import { PlanLimits } from '../../domain/value-objects/PlanLimits.js';
import { PlanName } from '../../domain/value-objects/PlanName.js';
import { SubscriptionId } from '../../domain/value-objects/SubscriptionId.js';
import { UpgradeSubscriptionPlanHandler } from './UpgradeSubscriptionPlan.js';

const TENANT_ID = uuidAt(1);
const CATALOG_CLOCK = new FixedClock('2026-01-01T00:00:00Z');

interface SeededPlan {
  readonly plan: Plan;
  readonly price: PlanPrice;
}

async function seedPlan(
  planRepository: InMemoryPlanRepository,
  planPriceRepository: InMemoryPlanPriceRepository,
  code: PlanCode,
  amountXof: number,
  limits: { maxUsers: number; maxBeds: number },
  idGenerator: SequentialIdGenerator,
): Promise<SeededPlan> {
  const plan = Plan.create({
    code,
    name: PlanName.create(code).getValue(),
    limits: PlanLimits.create(limits.maxUsers, limits.maxBeds).getValue(),
    clock: CATALOG_CLOCK,
    idGenerator,
  });
  await planRepository.save(plan);

  const price = PlanPrice.create({
    planId: plan.id,
    amount: Money.fromXOF(amountXof).getValue(),
    period: 'MENSUEL',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    clock: CATALOG_CLOCK,
    idGenerator,
  });
  await planPriceRepository.save(price);

  return { plan, price };
}

async function buildScenario() {
  const planRepository = new InMemoryPlanRepository();
  const planPriceRepository = new InMemoryPlanPriceRepository();
  const subscriptionRepository = new InMemorySubscriptionRepository();
  const planChangeRepository = new InMemoryPlanChangeRepository();
  const unitOfWork = new InMemoryUnitOfWork();
  const idGenerator = new SequentialIdGenerator();

  const standard = await seedPlan(planRepository, planPriceRepository, 'STANDARD', 35_000, { maxUsers: 10, maxBeds: 20 }, idGenerator);
  const professionnel = await seedPlan(
    planRepository,
    planPriceRepository,
    'PROFESSIONNEL',
    55_000,
    { maxUsers: 30, maxBeds: 50 },
    idGenerator,
  );
  const complet = await seedPlan(planRepository, planPriceRepository, 'COMPLET', 75_000, { maxUsers: 100, maxBeds: 200 }, idGenerator);

  // Periode mensuelle du 2026-08-01 au 2026-08-31 (30 jours), abonnement STANDARD deja en cours
  // (statut ACTIVE plutot que TRIALING : le paiement reel est hors perimetre, seul l'etat
  // importe pour tester le calcul de proratisation).
  const tenantId = TenantId.create(TENANT_ID).getValue();
  const subscription = Subscription.reconstitute(SubscriptionId.create(idGenerator.generate()).getValue(), {
    tenantId,
    planId: standard.plan.id,
    currentPlanPriceId: standard.price.id,
    period: 'MENSUEL',
    status: 'ACTIVE',
    trialEndsAt: null,
    periodStartsAt: new Date('2026-08-01T00:00:00Z'),
    periodEndsAt: new Date('2026-08-31T00:00:00Z'),
    createdAt: new Date('2026-08-01T00:00:00Z'),
  });
  await subscriptionRepository.save(subscription, tenantId);

  const clock = new FixedClock('2026-08-16T00:00:00Z'); // 15 jours restants sur 30
  const handler = new UpgradeSubscriptionPlanHandler(
    planRepository,
    planPriceRepository,
    subscriptionRepository,
    planChangeRepository,
    unitOfWork,
    clock,
    idGenerator,
  );

  return { planRepository, planPriceRepository, subscriptionRepository, planChangeRepository, unitOfWork, clock, handler, standard, professionnel, complet, tenantId };
}

describe('UpgradeSubscriptionPlanHandler', () => {
  it('upgrade STANDARD -> PROFESSIONNEL a mi-periode, proratise et historise', async () => {
    const { handler, subscriptionRepository, planChangeRepository, professionnel, tenantId } = await buildScenario();

    const result = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'PROFESSIONNEL' });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().proratedAmountXof).toBe(10_000); // (55000-35000)*15/30
    expect(result.getValue().newPlanPriceId).toBe(professionnel.price.id.toString());

    const subscription = await subscriptionRepository.findByTenantId(tenantId);
    expect(subscription?.planId.equals(professionnel.plan.id)).toBe(true);
    expect(subscription?.currentPlanPriceId.equals(professionnel.price.id)).toBe(true);
    // La periode en cours n'est pas reinitialisee par l'upgrade.
    expect(subscription?.periodStartsAt).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(subscription?.periodEndsAt).toEqual(new Date('2026-08-31T00:00:00Z'));

    const history = await planChangeRepository.listBySubscriptionId(subscription!.id, tenantId);
    expect(history).toHaveLength(1);
    expect(history[0]?.changeType).toBe('UPGRADE');
    expect(history[0]?.proratedAmount.amount).toBe(10_000);
  });

  it('deux upgrades successifs dans la meme periode : le second se facture depuis PROFESSIONNEL, pas depuis STANDARD, et cree une DEUXIEME ligne d_historique distincte', async () => {
    const { handler, planChangeRepository, subscriptionRepository, tenantId } = await buildScenario();

    const first = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'PROFESSIONNEL' });
    expect(first.isSuccess()).toBe(true);
    expect(first.getValue().proratedAmountXof).toBe(10_000); // (55000-35000)*15/30

    const second = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'COMPLET' });
    expect(second.isSuccess()).toBe(true);
    expect(second.getValue().proratedAmountXof).toBe(10_000); // (75000-55000)*15/30, PAS (75000-35000)*15/30 = 20000

    const subscription = await subscriptionRepository.findByTenantId(tenantId);
    const history = await planChangeRepository.listBySubscriptionId(subscription!.id, tenantId);
    expect(history).toHaveLength(2);
    expect(history[0]?.toPlanId.toString()).not.toBe(history[1]?.toPlanId.toString());
  });

  it("refuse un 'upgrade' vers un forfait de prix inferieur ou egal (NOT_AN_UPGRADE), et ne modifie ni l_abonnement ni l_historique", async () => {
    const { handler, planChangeRepository, subscriptionRepository, tenantId, standard } = await buildScenario();

    // D'abord un upgrade reel vers PROFESSIONNEL...
    await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'PROFESSIONNEL' });

    // ... puis une tentative de "upgrade" vers STANDARD (prix inferieur) : refusee.
    const result = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'STANDARD' });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('NOT_AN_UPGRADE');

    const subscription = await subscriptionRepository.findByTenantId(tenantId);
    expect(subscription?.planId.equals(standard.plan.id)).toBe(false); // reste PROFESSIONNEL

    const history = await planChangeRepository.listBySubscriptionId(subscription!.id, tenantId);
    expect(history).toHaveLength(1); // seul le premier upgrade reel est historise
  });

  it('rejette un code de forfait invalide', async () => {
    const { handler } = await buildScenario();
    const result = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'INEXISTANT' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_PLAN_CODE');
  });

  it('rejette un tenantId invalide', async () => {
    const { handler } = await buildScenario();
    const result = await handler.execute({ tenantId: 'not-a-uuid', targetPlanCode: 'PROFESSIONNEL' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_TENANT_ID');
  });

  it('echoue si le tenant ne possede aucun abonnement', async () => {
    const { handler } = await buildScenario();
    const otherTenant = uuidAt(999);
    const result = await handler.execute({ tenantId: otherTenant, targetPlanCode: 'PROFESSIONNEL' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('SUBSCRIPTION_NOT_FOUND');
  });

  it('positionne le contexte RLS (UnitOfWorkContext.tenantId) sur le tenant de la commande', async () => {
    const { handler, unitOfWork } = await buildScenario();
    await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'PROFESSIONNEL' });
    expect(unitOfWork.lastContext?.tenantId?.toString()).toBe(TENANT_ID);
  });
});
