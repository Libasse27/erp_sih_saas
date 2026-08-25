import { describe, expect, it } from 'vitest';
import { Money } from '../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { FixedClock, SequentialIdGenerator, uuidAt } from '../../../../test/subscription/builders/testKit.js';
import { Subscription, UPGRADE_REQUEST_TTL_HOURS } from './Subscription.js';
import { PlanId } from './value-objects/PlanId.js';
import { PlanPriceId } from './value-objects/PlanPriceId.js';
import { SubscriptionId } from './value-objects/SubscriptionId.js';
import type { SubscriptionStatus } from './value-objects/SubscriptionStatus.js';

const TENANT = TenantId.create(uuidAt(1)).getValue();
const CURRENT_PLAN = PlanId.create(uuidAt(10)).getValue();
const CURRENT_PRICE = PlanPriceId.create(uuidAt(11)).getValue();
const TARGET_PLAN = PlanId.create(uuidAt(20)).getValue();
const TARGET_PRICE = PlanPriceId.create(uuidAt(21)).getValue();
const PLAN_CHANGE_ID = uuidAt(30);

const NOW = new Date('2026-08-16T00:00:00Z');
const PERIOD_ENDS_AT = new Date('2026-08-31T00:00:00Z');

function subscriptionWithStatus(status: SubscriptionStatus): Subscription {
  return Subscription.reconstitute(SubscriptionId.create(uuidAt(2)).getValue(), {
    tenantId: TENANT,
    planId: CURRENT_PLAN,
    currentPlanPriceId: CURRENT_PRICE,
    period: 'MENSUEL',
    status,
    trialEndsAt: status === 'TRIALING' ? PERIOD_ENDS_AT : null,
    periodStartsAt: new Date('2026-08-01T00:00:00Z'),
    periodEndsAt: PERIOD_ENDS_AT,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    gracePeriodStartedAt: status === 'GRACE_PERIOD' ? new Date('2026-08-10T00:00:00Z') : null,
    degradedModeEnteredAt: status === 'DEGRADED' ? new Date('2026-08-12T00:00:00Z') : null,
    degradedModeSustainedNotifiedAt: null,
  });
}

function requestUpgradeOn(subscription: Subscription) {
  return subscription.requestUpgrade({
    planChangeId: PLAN_CHANGE_ID,
    toPlanId: TARGET_PLAN,
    toPlanPriceId: TARGET_PRICE,
    proratedAmount: Money.fromXOF(10_000).getValue(),
    now: NOW,
    clock: new FixedClock(NOW.toISOString()),
    idGenerator: new SequentialIdGenerator(),
  });
}

describe('Subscription.requestUpgrade()', () => {
  it('NE CHANGE PAS le forfait : c_est une demande, pas une application (le changement attend le paiement)', () => {
    const subscription = subscriptionWithStatus('ACTIVE');

    requestUpgradeOn(subscription);

    expect(subscription.planId.equals(CURRENT_PLAN)).toBe(true);
    expect(subscription.currentPlanPriceId.equals(CURRENT_PRICE)).toBe(true);
  });

  it('emet SubscriptionUpgradeRequested (et JAMAIS SubscriptionPlanChanged) avec les valeurs figees de la demande', () => {
    const subscription = subscriptionWithStatus('ACTIVE');

    requestUpgradeOn(subscription);

    const events = subscription.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('subscription.subscription.upgrade-requested');
    const event = events[0] as unknown as {
      planChangeId: string;
      fromPlanPriceId: string;
      toPlanPriceId: string;
      proratedAmountXof: number;
      coveredPeriodStartsAt: string;
      coveredPeriodEndsAt: string;
    };
    expect(event.planChangeId).toBe(PLAN_CHANGE_ID);
    expect(event.fromPlanPriceId).toBe(CURRENT_PRICE.toString());
    expect(event.toPlanPriceId).toBe(TARGET_PRICE.toString());
    expect(event.proratedAmountXof).toBe(10_000);
    // La fenetre couverte est celle qui a servi d'assiette au prorata : de MAINTENANT a la fin de
    // la periode en cours — pas le cycle de facturation complet (voir requestUpgrade).
    expect(event.coveredPeriodStartsAt).toBe(NOW.toISOString());
    expect(event.coveredPeriodEndsAt).toBe(PERIOD_ENDS_AT.toISOString());
  });

  it('fixe expiresAt a exactement UPGRADE_REQUEST_TTL_HOURS apres la demande (TTL tranche par le PO)', () => {
    const subscription = subscriptionWithStatus('ACTIVE');

    const request = requestUpgradeOn(subscription);

    expect(request.expiresAt.getTime() - NOW.getTime()).toBe(UPGRADE_REQUEST_TTL_HOURS * 60 * 60 * 1000);
    expect(request.id.toString()).toBe(PLAN_CHANGE_ID);
    expect(request.requestedAt).toEqual(NOW);
  });

  // Decision produit : upgrade RESERVE aux abonnements ACTIVE. La precondition est verifiee en
  // amont par UpgradeSubscriptionPlanHandler (qui renvoie SUBSCRIPTION_NOT_UPGRADABLE) ; l'atteindre
  // ici serait un bug de programmation, d'ou l'exception plutot qu'un Result.
  for (const status of ['TRIALING', 'GRACE_PERIOD', 'DEGRADED'] as const) {
    it(`leve une exception depuis le statut ${status} (precondition violee, jamais un echec metier attendu)`, () => {
      const subscription = subscriptionWithStatus(status);

      expect(() => requestUpgradeOn(subscription)).toThrow();
      // Aucun effet de bord : ni mutation, ni evenement accumule sur l'agregat.
      expect(subscription.currentPlanPriceId.equals(CURRENT_PRICE)).toBe(true);
      expect(subscription.pullDomainEvents()).toHaveLength(0);
    });
  }
});

describe('Subscription.applyPlanUpgrade()', () => {
  it('est IDEMPOTENTE : reappliquer le MEME upgrade ne remue rien et n_emet aucun second evenement', () => {
    // Cas reel : re-livraison at-least-once du meme SaaSPaymentSucceeded par l'Outbox.
    const subscription = subscriptionWithStatus('ACTIVE');
    const clock = new FixedClock('2026-08-16T00:10:00Z');

    subscription.applyPlanUpgrade({
      newPlanId: TARGET_PLAN,
      newPlanPriceId: TARGET_PRICE,
      clock,
      idGenerator: new SequentialIdGenerator(),
    });
    expect(subscription.pullDomainEvents()).toHaveLength(1);

    subscription.applyPlanUpgrade({
      newPlanId: TARGET_PLAN,
      newPlanPriceId: TARGET_PRICE,
      clock,
      idGenerator: new SequentialIdGenerator(),
    });

    expect(subscription.pullDomainEvents()).toHaveLength(0);
    expect(subscription.planId.equals(TARGET_PLAN)).toBe(true);
  });

  it('n_est PAS court-circuitee si seul le tarif change a forfait identique (changement de PlanPrice du meme Plan)', () => {
    // La garde no-op porte sur le COUPLE (planId, planPriceId) : un nouveau tarif du meme forfait
    // reste un changement reel a historiser, jamais un doublon a ignorer.
    const subscription = subscriptionWithStatus('ACTIVE');
    const otherPriceOfSamePlan = PlanPriceId.create(uuidAt(12)).getValue();

    subscription.applyPlanUpgrade({
      newPlanId: CURRENT_PLAN,
      newPlanPriceId: otherPriceOfSamePlan,
      clock: new FixedClock('2026-08-16T00:10:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    expect(subscription.pullDomainEvents()).toHaveLength(1);
    expect(subscription.currentPlanPriceId.equals(otherPriceOfSamePlan)).toBe(true);
  });

  it('ne reinitialise jamais le cycle de facturation en cours (O-02.6)', () => {
    const subscription = subscriptionWithStatus('ACTIVE');
    const periodEndsAtBefore = subscription.periodEndsAt;

    subscription.applyPlanUpgrade({
      newPlanId: TARGET_PLAN,
      newPlanPriceId: TARGET_PRICE,
      clock: new FixedClock('2026-08-16T00:10:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    expect(subscription.periodEndsAt).toEqual(periodEndsAtBefore);
  });
});

describe('PlanUpgradeRequest.isExpired()', () => {
  it('devient expiree A l_instant EXACT du TTL (borne incluse), pas une milliseconde plus tard', () => {
    const request = requestUpgradeOn(subscriptionWithStatus('ACTIVE'));
    const expiresAt = request.expiresAt;

    expect(request.isExpired(new Date(expiresAt.getTime() - 1))).toBe(false);
    expect(request.isExpired(expiresAt)).toBe(true);
    expect(request.isExpired(new Date(expiresAt.getTime() + 1))).toBe(true);
  });
});
