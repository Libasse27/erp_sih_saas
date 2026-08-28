import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { FixedClock, SequentialIdGenerator, uuidAt } from '../../../../test/subscription/builders/testKit.js';
import { Subscription } from './Subscription.js';
import { PlanId } from './value-objects/PlanId.js';
import { PlanPriceId } from './value-objects/PlanPriceId.js';

function tenantId(): TenantId {
  return TenantId.create(uuidAt(1)).getValue();
}

function activeSubscription(params: { periodEndsAt: string; status?: 'TRIALING' | 'ACTIVE' } = { periodEndsAt: '2026-08-31T00:00:00Z' }): Subscription {
  const subscription = Subscription.startTrial({
    tenantId: tenantId(),
    standardPlanId: PlanId.create(uuidAt(10)).getValue(),
    standardPlanPriceId: PlanPriceId.create(uuidAt(20)).getValue(),
    ownerUserId: uuidAt(500),
    clock: new FixedClock('2026-08-01T00:00:00Z'),
    idGenerator: new SequentialIdGenerator(),
  });
  subscription.pullDomainEvents();
  if (params.status === 'ACTIVE') {
    subscription.renew({
      newPeriodStartsAt: new Date('2026-08-01T00:00:00Z'),
      newPeriodEndsAt: new Date(params.periodEndsAt),
      clock: new FixedClock('2026-08-01T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.pullDomainEvents();
  }
  return subscription;
}

describe('Subscription — cycle de grace/mode degrade (O-03/O-25.6, etape 5)', () => {
  it('isRenewalDue() est vrai des que periodEndsAt <= now, pour TRIALING comme pour ACTIVE', () => {
    const trial = activeSubscription({ periodEndsAt: '2026-08-31T00:00:00Z' });
    expect(trial.isRenewalDue(new Date('2026-08-30T23:59:59Z'))).toBe(false);
    expect(trial.isRenewalDue(new Date('2026-08-31T00:00:00Z'))).toBe(true);

    const active = activeSubscription({ periodEndsAt: '2026-09-30T00:00:00Z', status: 'ACTIVE' });
    expect(active.isRenewalDue(new Date('2026-09-30T00:00:00Z'))).toBe(true);
  });

  it('markRenewalDue() emet SubscriptionRenewalDue avec le montant/periode fournis, SANS changer le statut', () => {
    const subscription = activeSubscription();
    subscription.markRenewalDue({
      amountXof: 35_000,
      newPeriodStartsAt: new Date('2026-08-31T00:00:00Z'),
      newPeriodEndsAt: new Date('2026-09-30T00:00:00Z'),
      clock: new FixedClock('2026-08-31T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    const events = subscription.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('subscription.subscription.renewal-due');
    expect(subscription.status).toBe('TRIALING');
  });

  it('startGracePeriod() demarre la grace IMMEDIATEMENT (meme instant que l_echeance) — decision confirmee etape 5', () => {
    const subscription = activeSubscription();
    const now = new Date('2026-08-31T00:00:00Z');

    subscription.startGracePeriod({ now, clock: new FixedClock(now.toISOString()), idGenerator: new SequentialIdGenerator() });

    expect(subscription.status).toBe('GRACE_PERIOD');
    expect(subscription.gracePeriodStartedAt).toEqual(now);
    const events = subscription.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('subscription.subscription.grace-period-started');
  });

  it('isGracePeriodExpired() devient vrai a J+7 exactement, pas avant', () => {
    const subscription = activeSubscription();
    subscription.startGracePeriod({
      now: new Date('2026-08-31T00:00:00Z'),
      clock: new FixedClock('2026-08-31T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    expect(subscription.isGracePeriodExpired(new Date('2026-09-06T23:59:59Z'))).toBe(false);
    expect(subscription.isGracePeriodExpired(new Date('2026-09-07T00:00:00Z'))).toBe(true);
  });

  it('enterDegradedMode() passe DEGRADED et emet SubscriptionDegradedModeEntered', () => {
    const subscription = activeSubscription();
    subscription.startGracePeriod({
      now: new Date('2026-08-31T00:00:00Z'),
      clock: new FixedClock('2026-08-31T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.pullDomainEvents();

    const now = new Date('2026-09-07T00:00:00Z');
    subscription.enterDegradedMode({ now, clock: new FixedClock(now.toISOString()), idGenerator: new SequentialIdGenerator() });

    expect(subscription.status).toBe('DEGRADED');
    expect(subscription.degradedModeEnteredAt).toEqual(now);
    expect(subscription.pullDomainEvents()[0]?.eventType).toBe('subscription.subscription.degraded-mode-entered');
  });

  it('isDegradedModeSustainDue() devient vrai a J+37 (J+7 + 30 jours) exactement', () => {
    const subscription = activeSubscription();
    subscription.startGracePeriod({
      now: new Date('2026-08-31T00:00:00Z'),
      clock: new FixedClock('2026-08-31T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.enterDegradedMode({
      now: new Date('2026-09-07T00:00:00Z'),
      clock: new FixedClock('2026-09-07T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    expect(subscription.isDegradedModeSustainDue(new Date('2026-10-06T23:59:59Z'))).toBe(false);
    expect(subscription.isDegradedModeSustainDue(new Date('2026-10-07T00:00:00Z'))).toBe(true);
  });

  it('sustainDegradedMode() est IDEMPOTENT : un second appel ne re-emet pas SubscriptionDegradedModeSustained (maintien indefini, une seule notification)', () => {
    const subscription = activeSubscription();
    subscription.startGracePeriod({
      now: new Date('2026-08-31T00:00:00Z'),
      clock: new FixedClock('2026-08-31T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.enterDegradedMode({
      now: new Date('2026-09-07T00:00:00Z'),
      clock: new FixedClock('2026-09-07T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.pullDomainEvents();

    subscription.sustainDegradedMode({ clock: new FixedClock('2026-10-07T00:00:00Z'), idGenerator: new SequentialIdGenerator() });
    expect(subscription.pullDomainEvents()).toHaveLength(1);

    subscription.sustainDegradedMode({ clock: new FixedClock('2026-11-07T00:00:00Z'), idGenerator: new SequentialIdGenerator() });
    expect(subscription.pullDomainEvents()).toHaveLength(0);
    expect(subscription.status).toBe('DEGRADED');
  });

  // --- Adversarial (coordinateur) : paiement recu PENDANT la grace ---
  it('reactivate() depuis GRACE_PERIOD (paiement recu ENTRE J+0 et J+7) sort immediatement de grace, emet SubscriptionReactivated', () => {
    const subscription = activeSubscription();
    subscription.startGracePeriod({
      now: new Date('2026-08-31T00:00:00Z'),
      clock: new FixedClock('2026-08-31T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.pullDomainEvents();

    subscription.reactivate({
      newPeriodStartsAt: new Date('2026-08-31T00:00:00Z'),
      newPeriodEndsAt: new Date('2026-09-30T00:00:00Z'),
      clock: new FixedClock('2026-09-03T12:00:00Z'), // J+3, avant J+7
      idGenerator: new SequentialIdGenerator(),
    });

    expect(subscription.status).toBe('ACTIVE');
    expect(subscription.gracePeriodStartedAt).toBeNull();
    expect(subscription.pullDomainEvents()[0]?.eventType).toBe('subscription.subscription.reactivated');
  });

  // --- Adversarial (coordinateur) : paiement recu PENDANT le mode degrade, y compris apres J+37 ---
  it('reactivate() depuis DEGRADED (paiement recu APRES J+37, maintien indefini) sort immediatement, "a tout moment" (O-25.6)', () => {
    const subscription = activeSubscription();
    subscription.startGracePeriod({
      now: new Date('2026-08-31T00:00:00Z'),
      clock: new FixedClock('2026-08-31T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.enterDegradedMode({
      now: new Date('2026-09-07T00:00:00Z'),
      clock: new FixedClock('2026-09-07T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.sustainDegradedMode({ clock: new FixedClock('2026-10-07T00:00:00Z'), idGenerator: new SequentialIdGenerator() });
    subscription.pullDomainEvents();

    // Bien apres J+37 (ex. 6 mois plus tard) — maintien indefini n'empeche jamais la reactivation.
    subscription.reactivate({
      newPeriodStartsAt: new Date('2027-03-01T00:00:00Z'),
      newPeriodEndsAt: new Date('2027-04-01T00:00:00Z'),
      clock: new FixedClock('2027-03-01T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    expect(subscription.status).toBe('ACTIVE');
    expect(subscription.degradedModeEnteredAt).toBeNull();
    expect(subscription.degradedModeSustainedNotifiedAt).toBeNull();
    expect(subscription.pullDomainEvents()[0]?.eventType).toBe('subscription.subscription.reactivated');
  });

  it('reactivate() est IDEMPOTENT : rejoue le meme evenement (re-livraison Outbox) ne produit pas de second SubscriptionReactivated', () => {
    const subscription = activeSubscription();
    subscription.startGracePeriod({
      now: new Date('2026-08-31T00:00:00Z'),
      clock: new FixedClock('2026-08-31T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    subscription.pullDomainEvents();

    const reactivateParams = {
      newPeriodStartsAt: new Date('2026-08-31T00:00:00Z'),
      newPeriodEndsAt: new Date('2026-09-30T00:00:00Z'),
      clock: new FixedClock('2026-09-03T12:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    };
    subscription.reactivate(reactivateParams);
    subscription.pullDomainEvents();

    subscription.reactivate(reactivateParams);

    expect(subscription.status).toBe('ACTIVE');
    expect(subscription.pullDomainEvents()).toHaveLength(0);
  });

  it('renew() depuis ACTIVE (jamais entre en grace) emet SubscriptionRenewed, pas SubscriptionReactivated', () => {
    const subscription = activeSubscription({ periodEndsAt: '2026-09-30T00:00:00Z', status: 'ACTIVE' });

    subscription.renew({
      newPeriodStartsAt: new Date('2026-09-30T00:00:00Z'),
      newPeriodEndsAt: new Date('2026-10-30T00:00:00Z'),
      clock: new FixedClock('2026-09-29T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    expect(subscription.status).toBe('ACTIVE');
    expect(subscription.pullDomainEvents()[0]?.eventType).toBe('subscription.subscription.renewed');
  });

  // --- Adversarial (coordinateur) : fin de periode d'essai = meme mecanisme qu'un renouvellement ---
  it('un abonnement TRIALING suit EXACTEMENT le meme chemin qu_un abonnement payant : echeance -> grace -> reactivate() au paiement', () => {
    const subscription = activeSubscription(); // TRIALING, periodEndsAt = trialEndsAt = 2026-08-31
    expect(subscription.status).toBe('TRIALING');
    expect(subscription.trialEndsAt).not.toBeNull();

    subscription.startGracePeriod({
      now: new Date('2026-08-31T00:00:00Z'),
      clock: new FixedClock('2026-08-31T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    expect(subscription.status).toBe('GRACE_PERIOD');

    subscription.reactivate({
      newPeriodStartsAt: new Date('2026-08-31T00:00:00Z'),
      newPeriodEndsAt: new Date('2026-09-30T00:00:00Z'),
      clock: new FixedClock('2026-09-02T00:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    expect(subscription.status).toBe('ACTIVE');
    expect(subscription.trialEndsAt).toBeNull(); // essai efface, converti en abonnement payant
  });
});
