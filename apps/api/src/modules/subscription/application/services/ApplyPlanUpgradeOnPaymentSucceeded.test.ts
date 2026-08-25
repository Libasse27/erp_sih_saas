import { describe, expect, it } from 'vitest';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { OutboxEventEnvelope } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import {
  FixedClock,
  InMemoryPlanChangeRepository,
  InMemoryPlanUpgradeRequestRepository,
  InMemorySubscriptionRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/subscription/builders/testKit.js';
import { Subscription } from '../../domain/Subscription.js';
import { PlanId } from '../../domain/value-objects/PlanId.js';
import { PlanPriceId } from '../../domain/value-objects/PlanPriceId.js';
import { SubscriptionId } from '../../domain/value-objects/SubscriptionId.js';
import { createApplyPlanUpgradeOnPaymentSucceededHandler } from './ApplyPlanUpgradeOnPaymentSucceeded.js';

const TENANT = TenantId.create(uuidAt(1)).getValue();
const SUBSCRIPTION_ID = SubscriptionId.create(uuidAt(2)).getValue();
const CURRENT_PLAN = PlanId.create(uuidAt(10)).getValue();
const CURRENT_PRICE = PlanPriceId.create(uuidAt(11)).getValue();
const TARGET_PLAN = PlanId.create(uuidAt(20)).getValue();
const TARGET_PRICE = PlanPriceId.create(uuidAt(21)).getValue();
const PLAN_CHANGE_ID = uuidAt(30);
const PLATFORM_INVOICE_ID = uuidAt(40);

const REQUESTED_AT = new Date('2026-08-16T00:00:00Z');
const CONFIRMED_AT = new Date('2026-08-16T00:30:00Z');

/** Capture les logs `warn` sans dependre d'un vrai logger — les paiements orphelins ne produisent AUCUN effet d'etat, seule cette trace les rend observables. */
class RecordingLogger {
  public readonly warnings: { fields: Record<string, unknown>; message: string }[] = [];

  warn(fields: Record<string, unknown>, message: string): void {
    this.warnings.push({ fields, message });
  }
}

function activeSubscription(currentPlanPriceId = CURRENT_PRICE): Subscription {
  return Subscription.reconstitute(SUBSCRIPTION_ID, {
    tenantId: TENANT,
    planId: CURRENT_PLAN,
    currentPlanPriceId,
    period: 'MENSUEL',
    status: 'ACTIVE',
    trialEndsAt: null,
    periodStartsAt: new Date('2026-08-01T00:00:00Z'),
    periodEndsAt: new Date('2026-08-31T00:00:00Z'),
    createdAt: new Date('2026-08-01T00:00:00Z'),
    gracePeriodStartedAt: null,
    degradedModeEnteredAt: null,
    degradedModeSustainedNotifiedAt: null,
  });
}

function envelope(overrides: Partial<Record<string, unknown>> = {}): OutboxEventEnvelope {
  return {
    id: 'outbox-1',
    eventType: 'payment.payment.saas-payment-succeeded',
    eventVersion: 1,
    aggregateId: uuidAt(50),
    tenantId: TENANT.toString(),
    occurredAt: CONFIRMED_AT,
    payload: {
      tenantId: TENANT.toString(),
      subscriptionId: SUBSCRIPTION_ID.toString(),
      platformInvoiceId: PLATFORM_INVOICE_ID,
      purpose: 'UPGRADE',
      sourceReference: PLAN_CHANGE_ID,
      newPeriodStartsAt: '2026-08-16T00:00:00Z',
      newPeriodEndsAt: '2026-08-31T00:00:00Z',
      ...overrides,
    },
  };
}

/**
 * `withPendingRequest` : demande d'upgrade REELLEMENT produite par l'agregat (jamais un objet
 * fabrique a la main), puis persistee — exactement l'etat laisse par
 * `UpgradeSubscriptionPlanHandler` avant l'arrivee du paiement.
 */
async function buildScenario(options: { withPendingRequest: boolean; currentPlanPriceId?: PlanPriceId } = { withPendingRequest: true }) {
  const subscriptionRepository = new InMemorySubscriptionRepository();
  const planUpgradeRequestRepository = new InMemoryPlanUpgradeRequestRepository();
  const planChangeRepository = new InMemoryPlanChangeRepository();
  const unitOfWork = new InMemoryUnitOfWork();
  const clock = new FixedClock(CONFIRMED_AT.toISOString());
  const idGenerator = new SequentialIdGenerator();
  const logger = new RecordingLogger();

  const subscription = activeSubscription(options.currentPlanPriceId ?? CURRENT_PRICE);

  if (options.withPendingRequest) {
    const request = subscription.requestUpgrade({
      planChangeId: PLAN_CHANGE_ID,
      toPlanId: TARGET_PLAN,
      toPlanPriceId: TARGET_PRICE,
      proratedAmount: Money.fromXOF(10_000).getValue(),
      now: REQUESTED_AT,
      clock: new FixedClock(REQUESTED_AT.toISOString()),
      idGenerator,
    });
    await planUpgradeRequestRepository.replaceExpiredAndInsert(request, TENANT, REQUESTED_AT);
  }

  await subscriptionRepository.save(subscription, TENANT);
  subscriptionRepository.publishedEvents.length = 0;

  const handler = createApplyPlanUpgradeOnPaymentSucceededHandler({
    subscriptionRepository,
    planUpgradeRequestRepository,
    planChangeRepository,
    unitOfWork,
    clock,
    idGenerator,
    logger,
  });

  return { handler, subscriptionRepository, planUpgradeRequestRepository, planChangeRepository, logger };
}

describe('ApplyPlanUpgradeOnPaymentSucceeded — application d_un upgrade APRES confirmation du paiement', () => {
  it('NOMINAL : applique le forfait, historise le PlanChange et consomme la demande', async () => {
    const { handler, subscriptionRepository, planUpgradeRequestRepository, planChangeRepository } =
      await buildScenario();

    await handler(envelope());

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.planId.equals(TARGET_PLAN)).toBe(true);
    expect(subscription?.currentPlanPriceId.equals(TARGET_PRICE)).toBe(true);

    // L'historique reprend l'identifiant PRE-ATTRIBUE et rattache la facture qui a paye l'upgrade.
    const change = await planChangeRepository.findById(PLAN_CHANGE_ID, TENANT);
    expect(change?.changeType).toBe('UPGRADE');
    expect(change?.proratedAmount.amount).toBe(10_000);
    expect(change?.platformInvoiceId).toBe(PLATFORM_INVOICE_ID);
    // Demande et application sont deux instants distincts, tous deux conserves.
    expect(change?.requestedAt).toEqual(REQUESTED_AT);
    expect(change?.occurredAt).toEqual(CONFIRMED_AT);

    // La demande a rempli son role : elle disparait, liberant la place pour un futur upgrade.
    expect(planUpgradeRequestRepository.count()).toBe(0);

    const events = subscriptionRepository.publishedEvents;
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('subscription.subscription.plan-changed');
  });

  it('ne recalcule RIEN : le montant et les cibles proviennent de la demande figee, pas du catalogue courant', async () => {
    const { handler, planChangeRepository } = await buildScenario();

    await handler(envelope());

    const change = await planChangeRepository.findById(PLAN_CHANGE_ID, TENANT);
    expect(change?.fromPlanPriceId.equals(CURRENT_PRICE)).toBe(true);
    expect(change?.toPlanPriceId.equals(TARGET_PRICE)).toBe(true);
    expect(change?.proratedAmount.amount).toBe(10_000);
  });

  it('DOUBLE LIVRAISON : un second traitement du meme evenement n_emet aucun second SubscriptionPlanChanged', async () => {
    // At-least-once (D9) : rejouer l'evenement ne doit produire aucun effet observable
    // supplementaire — ni evenement, ni seconde ligne d'historique.
    const { handler, subscriptionRepository, planChangeRepository } = await buildScenario();

    await handler(envelope());
    await handler(envelope());

    expect(subscriptionRepository.publishedEvents).toHaveLength(1);
    const history = await planChangeRepository.listBySubscriptionId(SUBSCRIPTION_ID, TENANT);
    expect(history).toHaveLength(1);
  });

  it('IGNORE un paiement qui n_est pas un upgrade (purpose RENEWAL) : ce chemin appartient a la reactivation', async () => {
    const { handler, subscriptionRepository, planUpgradeRequestRepository } = await buildScenario();

    await handler(envelope({ purpose: 'RENEWAL', sourceReference: null }));

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.currentPlanPriceId.equals(CURRENT_PRICE)).toBe(true);
    expect(planUpgradeRequestRepository.count()).toBe(1); // la demande reste en attente
  });

  it('ORPHELIN — demande absente et jamais appliquee (remplacee entre-temps) : aucun effet, un log, aucune exception', async () => {
    // Cas central justifiant la correlation par sourceReference (ADR-0003) : un webhook tardif
    // (FAILED -> SUCCEEDED ou EXPIRED -> SUCCEEDED, transitions autorisees par Payment) regle une
    // demande depuis remplacee. L'appliquer facturerait le nouvel upgrade au prorata de l'ancien.
    const { handler, subscriptionRepository, logger, planChangeRepository } = await buildScenario({
      withPendingRequest: false,
    });

    await expect(handler(envelope())).resolves.toBeUndefined();

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.currentPlanPriceId.equals(CURRENT_PRICE)).toBe(true);
    expect(await planChangeRepository.listBySubscriptionId(SUBSCRIPTION_ID, TENANT)).toHaveLength(0);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.fields['event']).toBe('subscription.upgrade.unmatched_payment');
    expect(logger.warnings[0]?.fields['reason']).toBe('request_replaced_or_unknown');
    expect(logger.warnings[0]?.fields['planChangeId']).toBe(PLAN_CHANGE_ID);
  });

  it('ORPHELIN — subscriptionId du paiement different de celui de la demande : jamais applique', async () => {
    const { handler, subscriptionRepository, logger } = await buildScenario();

    await handler(envelope({ subscriptionId: uuidAt(777) }));

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.currentPlanPriceId.equals(CURRENT_PRICE)).toBe(true);
    expect(logger.warnings[0]?.fields['reason']).toBe('subscription_mismatch');
  });

  it('ORPHELIN — base de prorata invalidee (le tarif courant a change depuis la demande) : jamais applique', async () => {
    // Un renouvellement ou un autre changement est passe entre la demande et le paiement : le
    // montant paye ne correspond plus a l'ecart de tarif reel. Appliquer quand meme reviendrait a
    // vendre une montee en gamme au prix d'une autre.
    const { handler, subscriptionRepository, logger, planChangeRepository } = await buildScenario();
    const stored = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    stored?.applyPlanUpgrade({
      newPlanId: CURRENT_PLAN,
      newPlanPriceId: PlanPriceId.create(uuidAt(12)).getValue(),
      clock: new FixedClock('2026-08-16T00:10:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    if (stored !== null) {
      await subscriptionRepository.save(stored, TENANT);
    }
    subscriptionRepository.publishedEvents.length = 0;

    await handler(envelope());

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.currentPlanPriceId.equals(TARGET_PRICE)).toBe(false);
    expect(await planChangeRepository.listBySubscriptionId(SUBSCRIPTION_ID, TENANT)).toHaveLength(0);
    expect(logger.warnings[0]?.fields['reason']).toBe('proration_base_invalidated');
  });

  it('ORPHELIN — paiement d_upgrade sans sourceReference : aucune correlation de repli par subscriptionId', async () => {
    const { handler, subscriptionRepository, logger } = await buildScenario();

    await handler(envelope({ sourceReference: null }));

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.currentPlanPriceId.equals(CURRENT_PRICE)).toBe(true);
    expect(logger.warnings[0]?.fields['reason']).toBe('missing_source_reference');
  });

  it('RE-LIVRAISON APRES APPLICATION : demande absente MAIS PlanChange deja ecrit -> no-op silencieux, aucun log d_orphelin', async () => {
    const { handler, logger, subscriptionRepository } = await buildScenario();

    await handler(envelope());
    subscriptionRepository.publishedEvents.length = 0;
    await handler(envelope());

    expect(subscriptionRepository.publishedEvents).toHaveLength(0);
    // Distingue bien "deja traite" (normal) de "orphelin" (anomalie a regulariser).
    expect(logger.warnings).toHaveLength(0);
  });

  it('RETRY sur conflit de verrouillage optimiste : relit, reapplique et finit par sauvegarder', async () => {
    const { handler, subscriptionRepository, planChangeRepository } = await buildScenario();
    subscriptionRepository.failNextSaveWithConflict();

    await handler(envelope());

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.currentPlanPriceId.equals(TARGET_PRICE)).toBe(true);
    expect(await planChangeRepository.findById(PLAN_CHANGE_ID, TENANT)).not.toBeNull();
  });

  it('ISOLATION TENANT : la demande d_un autre tenant n_est jamais retrouvee, le paiement est traite comme orphelin', async () => {
    const { handler, subscriptionRepository, logger } = await buildScenario();
    const otherTenant = uuidAt(888);

    await handler(envelope({ tenantId: otherTenant }));

    const subscription = await subscriptionRepository.findById(SUBSCRIPTION_ID, TENANT);
    expect(subscription?.currentPlanPriceId.equals(CURRENT_PRICE)).toBe(true);
    expect(logger.warnings[0]?.fields['reason']).toBe('request_replaced_or_unknown');
  });
});
