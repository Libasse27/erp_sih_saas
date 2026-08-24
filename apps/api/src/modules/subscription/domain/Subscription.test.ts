import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { FixedClock, SequentialIdGenerator, uuidAt } from '../../../../test/subscription/builders/testKit.js';
import { Subscription, TRIAL_DURATION_DAYS } from './Subscription.js';
import { PlanId } from './value-objects/PlanId.js';
import { PlanPriceId } from './value-objects/PlanPriceId.js';

function tenantId(): TenantId {
  return TenantId.create(uuidAt(1)).getValue();
}

function planId(counter: number): PlanId {
  return PlanId.create(uuidAt(counter)).getValue();
}

function planPriceId(counter: number): PlanPriceId {
  return PlanPriceId.create(uuidAt(counter)).getValue();
}

describe('Subscription', () => {
  it('startTrial() demarre un abonnement TRIALING sur le forfait STANDARD, trialEndsAt a J+30', () => {
    const clock = new FixedClock('2026-08-24T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const tenant = tenantId();
    const standardPlanId = planId(10);
    const standardPlanPriceId = planPriceId(20);

    const subscription = Subscription.startTrial({
      tenantId: tenant,
      standardPlanId,
      standardPlanPriceId,
      clock,
      idGenerator,
    });

    expect(subscription.tenantId.equals(tenant)).toBe(true);
    expect(subscription.planId.equals(standardPlanId)).toBe(true);
    expect(subscription.currentPlanPriceId.equals(standardPlanPriceId)).toBe(true);
    expect(subscription.status).toBe('TRIALING');
    expect(TRIAL_DURATION_DAYS).toBe(30);
    expect(subscription.trialEndsAt).toEqual(new Date('2026-09-23T10:00:00Z'));
    expect(subscription.periodStartsAt).toEqual(new Date('2026-08-24T10:00:00Z'));
    expect(subscription.periodEndsAt).toEqual(subscription.trialEndsAt);
    expect(subscription.period).toBe('MENSUEL');
  });

  it('startTrial() emet SubscriptionStarted avec tenantId = tenant du contexte', () => {
    const tenant = tenantId();
    const subscription = Subscription.startTrial({
      tenantId: tenant,
      standardPlanId: planId(10),
      standardPlanPriceId: planPriceId(20),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    const events = subscription.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('subscription.subscription.started');
    expect(events[0]?.tenantId).toBe(tenant.toString());
    expect(events[0]?.aggregateId).toBe(subscription.id.toString());
  });

  it('changePlan() met a jour planId/currentPlanPriceId sans modifier la periode en cours', () => {
    const subscription = Subscription.startTrial({
      tenantId: tenantId(),
      standardPlanId: planId(10),
      standardPlanPriceId: planPriceId(20),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.pullDomainEvents();

    const periodStartsAtBefore = subscription.periodStartsAt;
    const periodEndsAtBefore = subscription.periodEndsAt;

    const newPlanId = planId(30);
    const newPlanPriceId = planPriceId(40);
    subscription.changePlan({
      newPlanId,
      newPlanPriceId,
      clock: new FixedClock('2026-08-30T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    expect(subscription.planId.equals(newPlanId)).toBe(true);
    expect(subscription.currentPlanPriceId.equals(newPlanPriceId)).toBe(true);
    expect(subscription.periodStartsAt).toEqual(periodStartsAtBefore);
    expect(subscription.periodEndsAt).toEqual(periodEndsAtBefore);
  });

  it('changePlan() emet SubscriptionPlanChanged avec fromPlanId/toPlanId corrects', () => {
    const initialPlanId = planId(10);
    const subscription = Subscription.startTrial({
      tenantId: tenantId(),
      standardPlanId: initialPlanId,
      standardPlanPriceId: planPriceId(20),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.pullDomainEvents();

    const targetPlanId = planId(30);
    subscription.changePlan({
      newPlanId: targetPlanId,
      newPlanPriceId: planPriceId(40),
      clock: new FixedClock('2026-08-30T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    const events = subscription.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('subscription.subscription.plan-changed');
    const event = events[0] as unknown as { fromPlanId: string; toPlanId: string };
    expect(event.fromPlanId).toBe(initialPlanId.toString());
    expect(event.toPlanId).toBe(targetPlanId.toString());
  });

  it('reconstitute() ne genere aucun evenement de domaine', () => {
    const subscription = Subscription.startTrial({
      tenantId: tenantId(),
      standardPlanId: planId(10),
      standardPlanPriceId: planPriceId(20),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.pullDomainEvents();

    const reconstituted = Subscription.reconstitute(subscription.id, {
      tenantId: subscription.tenantId,
      planId: subscription.planId,
      currentPlanPriceId: subscription.currentPlanPriceId,
      period: subscription.period,
      status: subscription.status,
      trialEndsAt: subscription.trialEndsAt,
      periodStartsAt: subscription.periodStartsAt,
      periodEndsAt: subscription.periodEndsAt,
      createdAt: subscription.createdAt,
    });

    expect(reconstituted.pullDomainEvents()).toHaveLength(0);
  });
});
