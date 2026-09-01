import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { OutboxEventEnvelope } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import {
  FixedClock,
  InMemorySubscriptionAuditTrail,
  InMemorySubscriptionRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/subscription/builders/testKit.js';
import { Subscription } from '../../domain/Subscription.js';
import { PlanId } from '../../domain/value-objects/PlanId.js';
import { PlanPriceId } from '../../domain/value-objects/PlanPriceId.js';
import { SubscriptionId } from '../../domain/value-objects/SubscriptionId.js';
import type { SubscriptionStatus } from '../../domain/value-objects/SubscriptionStatus.js';
import { createReactivateSubscriptionOnPaymentSucceededHandler } from './ReactivateSubscriptionOnPaymentSucceeded.js';

const TENANT = TenantId.create(uuidAt(1)).getValue();
const SUBSCRIPTION_ID = SubscriptionId.create(uuidAt(2)).getValue();

const NEW_PERIOD_STARTS_AT = '2026-08-31T00:00:00Z';
const NEW_PERIOD_ENDS_AT = '2026-09-30T00:00:00Z';

function subscriptionWithStatus(status: SubscriptionStatus): Subscription {
  return Subscription.reconstitute(SUBSCRIPTION_ID, {
    tenantId: TENANT,
    planId: PlanId.create(uuidAt(10)).getValue(),
    currentPlanPriceId: PlanPriceId.create(uuidAt(11)).getValue(),
    period: 'MENSUEL',
    status,
    trialEndsAt: null,
    periodStartsAt: new Date('2026-08-01T00:00:00Z'),
    periodEndsAt: new Date('2026-08-31T00:00:00Z'),
    createdAt: new Date('2026-08-01T00:00:00Z'),
    gracePeriodStartedAt: status === 'GRACE_PERIOD' ? new Date('2026-08-31T00:00:00Z') : null,
    degradedModeEnteredAt: status === 'DEGRADED' ? new Date('2026-09-07T00:00:00Z') : null,
    degradedModeSustainedNotifiedAt: null,
  });
}

function envelope(overrides: Record<string, unknown> = {}): OutboxEventEnvelope {
  return {
    id: 'outbox-1',
    eventType: 'payment.payment.saas-payment-succeeded',
    eventVersion: 1,
    aggregateId: uuidAt(50),
    tenantId: TENANT.toString(),
    occurredAt: new Date('2026-09-02T00:00:00Z'),
    payload: {
      tenantId: TENANT.toString(),
      subscriptionId: SUBSCRIPTION_ID.toString(),
      platformInvoiceId: uuidAt(40),
      purpose: 'RENEWAL',
      sourceReference: null,
      newPeriodStartsAt: NEW_PERIOD_STARTS_AT,
      newPeriodEndsAt: NEW_PERIOD_ENDS_AT,
      ...overrides,
    },
  };
}

async function buildScenario(status: SubscriptionStatus) {
  const subscriptionRepository = new InMemorySubscriptionRepository();
  const unitOfWork = new InMemoryUnitOfWork();
  const clock = new FixedClock('2026-09-02T00:00:00Z');
  const idGenerator = new SequentialIdGenerator();

  await subscriptionRepository.save(subscriptionWithStatus(status), TENANT);
  subscriptionRepository.publishedEvents.length = 0;

  const subscriptionAuditTrail = new InMemorySubscriptionAuditTrail();
  const handler = createReactivateSubscriptionOnPaymentSucceededHandler({
    subscriptionRepository,
    subscriptionAuditTrail,
    unitOfWork,
    clock,
    idGenerator,
  });

  return { handler, subscriptionRepository, subscriptionAuditTrail };
}

describe('ReactivateSubscriptionOnPaymentSucceeded — filtrage par nature du paiement', () => {
  it('NE FAIT RIEN sur un paiement d_UPGRADE : un prorata ne regle aucune periode de facturation', async () => {
    // Sans cette garde, le montant proratise d'une montee en gamme prolongerait `periodEndsAt` d'un
    // cycle entier — un mois de service offert contre un paiement partiel. Ce cas appartient
    // exclusivement a ApplyPlanUpgradeOnPaymentSucceeded.ts.
    const { handler, subscriptionRepository } = await buildScenario('ACTIVE');

    await handler(envelope({ purpose: 'UPGRADE', sourceReference: uuidAt(30) }));

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.periodEndsAt).toEqual(new Date('2026-08-31T00:00:00Z'));
    expect(subscriptionRepository.publishedEvents).toHaveLength(0);
  });

  it('NE SORT PAS de grace sur un paiement d_UPGRADE : un compte en defaut ne se regularise pas en montant en gamme', async () => {
    const { handler, subscriptionRepository } = await buildScenario('GRACE_PERIOD');

    await handler(envelope({ purpose: 'UPGRADE', sourceReference: uuidAt(30) }));

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.status).toBe('GRACE_PERIOD');
  });

  it('renouvelle bien un abonnement ACTIVE sur un paiement de RENOUVELLEMENT', async () => {
    const { handler, subscriptionRepository } = await buildScenario('ACTIVE');

    await handler(envelope());

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.status).toBe('ACTIVE');
    expect(subscription?.periodEndsAt).toEqual(new Date(NEW_PERIOD_ENDS_AT));
    expect(subscriptionRepository.publishedEvents[0]?.eventType).toBe('subscription.subscription.renewed');
  });

  it('reactive un abonnement en GRACE_PERIOD sur un paiement de RENOUVELLEMENT', async () => {
    const { handler, subscriptionRepository } = await buildScenario('GRACE_PERIOD');

    await handler(envelope());

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.status).toBe('ACTIVE');
    expect(subscription?.gracePeriodStartedAt).toBeNull();
    expect(subscriptionRepository.publishedEvents[0]?.eventType).toBe('subscription.subscription.reactivated');
  });

  it('traite un payload SANS `purpose` (message Outbox anterieur a la passe 2) comme un renouvellement', async () => {
    // Compatibilite ascendante : ces messages n'ont jamais pu concerner un upgrade, le chemin
    // n'existait pas. Les rejeter les enverrait en dead-letter sans raison.
    const { handler, subscriptionRepository } = await buildScenario('GRACE_PERIOD');

    await handler({
      id: 'outbox-legacy',
      eventType: 'payment.payment.saas-payment-succeeded',
      eventVersion: 1,
      aggregateId: uuidAt(50),
      tenantId: TENANT.toString(),
      occurredAt: new Date('2026-09-02T00:00:00Z'),
      payload: {
        tenantId: TENANT.toString(),
        subscriptionId: SUBSCRIPTION_ID.toString(),
        newPeriodStartsAt: NEW_PERIOD_STARTS_AT,
        newPeriodEndsAt: NEW_PERIOD_ENDS_AT,
      },
    });

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.status).toBe('ACTIVE');
  });

  it('RETRY sur conflit de verrouillage optimiste : relit, reapplique et finit par sauvegarder', async () => {
    const { handler, subscriptionRepository } = await buildScenario('GRACE_PERIOD');
    subscriptionRepository.failNextSaveWithConflict();

    await handler(envelope());

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.status).toBe('ACTIVE');
    expect(subscription?.periodEndsAt).toEqual(new Date(NEW_PERIOD_ENDS_AT));
  });
});
