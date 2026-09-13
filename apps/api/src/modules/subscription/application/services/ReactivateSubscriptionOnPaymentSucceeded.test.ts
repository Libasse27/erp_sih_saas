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

/**
 * Specialise `InMemorySubscriptionRepository` pour simuler, de maniere DETERMINISTE, la relecture
 * introuvable apres un conflit de verrouillage optimiste (`saveWithConcurrencyRetry`, branche
 * `reloaded === null`) — aucun fake existant du testKit partage ne permet de cibler un appel
 * PRECIS de `findById` par son rang, ajoute donc localement a ce seul fichier de test.
 */
class ReloadNullSubscriptionRepository extends InMemorySubscriptionRepository {
  private findByIdCallCount = 0;
  private nullOnCall: number | null = null;

  returnNullOnFindByIdCall(callIndex: number): void {
    this.nullOnCall = callIndex;
  }

  override async findById(id: SubscriptionId, tenantId: TenantId): Promise<Subscription | null> {
    this.findByIdCallCount += 1;
    if (this.nullOnCall === this.findByIdCallCount) {
      return null;
    }
    return super.findById(id, tenantId);
  }
}

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

  it('reactive un abonnement DEGRADED sur un paiement de RENOUVELLEMENT', async () => {
    const { handler, subscriptionRepository } = await buildScenario('DEGRADED');

    await handler(envelope());

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.status).toBe('ACTIVE');
    expect(subscriptionRepository.publishedEvents[0]?.eventType).toBe('subscription.subscription.reactivated');
  });

  it('payload invalide (champ manquant) -> leve une erreur explicite', async () => {
    const { handler } = await buildScenario('ACTIVE');

    await expect(
      handler({
        id: 'outbox-invalide',
        eventType: 'payment.payment.saas-payment-succeeded',
        eventVersion: 1,
        aggregateId: uuidAt(50),
        tenantId: TENANT.toString(),
        occurredAt: new Date('2026-09-02T00:00:00Z'),
        payload: { tenantId: TENANT.toString() },
      }),
    ).rejects.toThrow(/Payload invalide/);
  });

  it('identifiants invalides (tenantId ou subscriptionId) dans le payload -> leve une erreur', async () => {
    const { handler } = await buildScenario('ACTIVE');

    await expect(
      handler(envelope({ tenantId: 'pas-un-uuid' })),
    ).rejects.toThrow(/Identifiants invalides/);
  });

  it('abonnement introuvable pour ce tenant : ignore silencieusement (aucune exception, aucune ecriture)', async () => {
    const subscriptionRepository = new InMemorySubscriptionRepository();
    const unitOfWork = new InMemoryUnitOfWork();
    const clock = new FixedClock('2026-09-02T00:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const subscriptionAuditTrail = new InMemorySubscriptionAuditTrail();
    const handler = createReactivateSubscriptionOnPaymentSucceededHandler({
      subscriptionRepository,
      subscriptionAuditTrail,
      unitOfWork,
      clock,
      idGenerator,
    });

    await handler(envelope());

    expect(await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT)).toBeNull();
    expect(subscriptionAuditTrail.records).toHaveLength(0);
  });

  it('conflits de verrouillage optimiste persistants : abandon apres epuisement des tentatives', async () => {
    const { handler, subscriptionRepository } = await buildScenario('GRACE_PERIOD');
    subscriptionRepository.failNextSaveWithConflict(3);

    await expect(handler(envelope())).rejects.toThrow(/Conflit de verrouillage optimiste/);
  });

  it('conflit de verrouillage optimiste suivi d_une relecture introuvable : remonte l_erreur d_origine, jamais masquee', async () => {
    const subscriptionRepository = new ReloadNullSubscriptionRepository();
    const unitOfWork = new InMemoryUnitOfWork();
    const clock = new FixedClock('2026-09-02T00:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const subscriptionAuditTrail = new InMemorySubscriptionAuditTrail();

    await subscriptionRepository.save(subscriptionWithStatus('GRACE_PERIOD'), TENANT);
    subscriptionRepository.publishedEvents.length = 0;
    // Appel #1 = lecture initiale de l'abonnement (doit reussir) ; le conflit survient au premier
    // `save()` dans `saveWithConcurrencyRetry`, dont la RELECTURE consecutive est l'appel #2.
    subscriptionRepository.failNextSaveWithConflict();
    subscriptionRepository.returnNullOnFindByIdCall(2);

    const handler = createReactivateSubscriptionOnPaymentSucceededHandler({
      subscriptionRepository,
      subscriptionAuditTrail,
      unitOfWork,
      clock,
      idGenerator,
    });

    await expect(handler(envelope())).rejects.toThrow(/Conflit de verrouillage optimiste/);
  });
});
