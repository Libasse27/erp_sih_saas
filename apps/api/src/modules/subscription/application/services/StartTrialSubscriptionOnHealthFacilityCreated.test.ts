import { describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { Plan } from '../../domain/Plan.js';
import { PlanPrice } from '../../domain/PlanPrice.js';
import { PlanLimits } from '../../domain/value-objects/PlanLimits.js';
import { PlanName } from '../../domain/value-objects/PlanName.js';
import { StartTrialSubscriptionHandler } from '../commands/StartTrialSubscription.js';
import {
  FixedClock,
  InMemoryPlanPriceRepository,
  InMemoryPlanRepository,
  InMemorySubscriptionRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/subscription/builders/testKit.js';
import { createStartTrialSubscriptionOnHealthFacilityCreatedHandler } from './StartTrialSubscriptionOnHealthFacilityCreated.js';

const TENANT_A = uuidAt(9201);
const OWNER_USER_ID = uuidAt(500);

function envelope(overrides: Partial<OutboxEventEnvelope> = {}): OutboxEventEnvelope {
  return {
    id: uuidAt(1),
    eventType: 'tenant.health-facility.created',
    eventVersion: 1,
    aggregateId: TENANT_A,
    tenantId: TENANT_A,
    occurredAt: new Date('2026-08-28T00:00:00.000Z'),
    payload: { name: 'Etablissement Test', ownerUserId: OWNER_USER_ID },
    ...overrides,
  };
}

/** Reproduit exactement `seedStandardPlan` de StartTrialSubscription.test.ts (meme module, pas d'import infrastructure/ depuis application/, regle dependency-cruiser). */
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
}

describe('StartTrialSubscriptionOnHealthFacilityCreated (ADR-0008 §1/§4)', () => {
  async function build() {
    const planRepository = new InMemoryPlanRepository();
    const planPriceRepository = new InMemoryPlanPriceRepository();
    const subscriptionRepository = new InMemorySubscriptionRepository();
    const clock = new FixedClock('2026-08-28T00:00:00.000Z');
    const idGenerator = new SequentialIdGenerator();

    await seedStandardPlan(planRepository, planPriceRepository);

    const startTrialSubscriptionHandler = new StartTrialSubscriptionHandler(
      planRepository,
      planPriceRepository,
      subscriptionRepository,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );

    const handler = createStartTrialSubscriptionOnHealthFacilityCreatedHandler({ startTrialSubscriptionHandler });
    return { handler, subscriptionRepository };
  }

  it('demarre un essai gratuit STANDARD pour le tenant de l_evenement', async () => {
    const { handler, subscriptionRepository } = await build();

    await handler(envelope());

    const subscription = await subscriptionRepository.findByTenantId(TenantId.create(TENANT_A).getValue());
    expect(subscription).not.toBeNull();
    expect(subscription?.status).toBe('TRIALING');
  });

  it('leve si tenantId est absent de l_enveloppe (anomalie — HealthFacilityCreated porte toujours un tenant)', async () => {
    const { handler } = await build();
    await expect(handler(envelope({ tenantId: null }))).rejects.toThrow();
  });

  it("redelivrance (meme evenement) : idempotent — SUBSCRIPTION_ALREADY_EXISTS traite comme succes, aucun doublon", async () => {
    const { handler, subscriptionRepository } = await build();

    await handler(envelope());
    await handler(envelope());

    const events = subscriptionRepository.publishedEvents.filter((e) => e.eventType === 'subscription.subscription.started');
    expect(events).toHaveLength(1);
  });

  it("n'extrait AUCUN champ metier hors ownerUserId (name) du payload — seul envelope.tenantId et ownerUserId sont utilises", async () => {
    const { handler, subscriptionRepository } = await build();

    // `name` volontairement absent/corrompu — ne doit avoir aucune influence sur le resultat,
    // seul `ownerUserId` est extrait par le schema Zod de frontiere (`.passthrough()`).
    await handler(envelope({ payload: { anything: 'unexpected-shape', ownerUserId: OWNER_USER_ID } }));

    const events = subscriptionRepository.publishedEvents.filter((e) => e.eventType === 'subscription.subscription.started');
    expect(events).toHaveLength(1);
  });

  it('leve une erreur explicite (jamais silencieuse) si ownerUserId est absent du payload — jamais une identite devinee (ADR-0008 §9, amendement 1)', async () => {
    const { handler } = await build();
    await expect(handler(envelope({ payload: { name: 'Etablissement Test' } }))).rejects.toThrow();
  });

  it('propage fidelement ownerUserId depuis HealthFacilityCreated jusqu_a SubscriptionStarted (ADR-0008 §9, resequencement F3)', async () => {
    const { handler, subscriptionRepository } = await build();

    await handler(envelope());

    const events = subscriptionRepository.publishedEvents.filter((e) => e.eventType === 'subscription.subscription.started');
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { ownerUserId: string }).ownerUserId).toBe(OWNER_USER_ID);
  });

  it('leve une erreur explicite (jamais silencieuse) si le catalogue STANDARD est absent — le message Outbox doit rester PENDING et etre retente', async () => {
    const planRepository = new InMemoryPlanRepository();
    const planPriceRepository = new InMemoryPlanPriceRepository();
    const subscriptionRepository = new InMemorySubscriptionRepository();
    const startTrialSubscriptionHandler = new StartTrialSubscriptionHandler(
      planRepository,
      planPriceRepository,
      subscriptionRepository,
      new InMemoryUnitOfWork(),
      new FixedClock('2026-08-28T00:00:00.000Z'),
      new SequentialIdGenerator(),
    );
    const handler = createStartTrialSubscriptionOnHealthFacilityCreatedHandler({ startTrialSubscriptionHandler });

    await expect(handler(envelope())).rejects.toThrow(/STANDARD_PLAN_NOT_FOUND/);
  });
});
