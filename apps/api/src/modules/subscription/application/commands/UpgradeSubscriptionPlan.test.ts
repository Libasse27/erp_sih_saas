import { describe, expect, it } from 'vitest';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryPlanChangeRepository,
  InMemoryPlanPriceRepository,
  InMemoryPlanRepository,
  InMemoryPlanUpgradeRequestRepository,
  InMemorySubscriptionAuditTrail,
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
import type { SubscriptionStatus } from '../../domain/value-objects/SubscriptionStatus.js';
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

async function buildScenario(status: SubscriptionStatus = 'ACTIVE') {
  const planRepository = new InMemoryPlanRepository();
  const planPriceRepository = new InMemoryPlanPriceRepository();
  const subscriptionRepository = new InMemorySubscriptionRepository();
  const planChangeRepository = new InMemoryPlanChangeRepository();
  const planUpgradeRequestRepository = new InMemoryPlanUpgradeRequestRepository();
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

  // Periode mensuelle du 2026-08-01 au 2026-08-31 (30 jours), abonnement STANDARD deja en cours.
  const tenantId = TenantId.create(TENANT_ID).getValue();
  const subscription = Subscription.reconstitute(SubscriptionId.create(idGenerator.generate()).getValue(), {
    tenantId,
    planId: standard.plan.id,
    currentPlanPriceId: standard.price.id,
    period: 'MENSUEL',
    status,
    trialEndsAt: status === 'TRIALING' ? new Date('2026-08-31T00:00:00Z') : null,
    periodStartsAt: new Date('2026-08-01T00:00:00Z'),
    periodEndsAt: new Date('2026-08-31T00:00:00Z'),
    createdAt: new Date('2026-08-01T00:00:00Z'),
    gracePeriodStartedAt: status === 'GRACE_PERIOD' ? new Date('2026-08-10T00:00:00Z') : null,
    degradedModeEnteredAt: status === 'DEGRADED' ? new Date('2026-08-12T00:00:00Z') : null,
    degradedModeSustainedNotifiedAt: null,
  });
  await subscriptionRepository.save(subscription, tenantId);
  subscriptionRepository.publishedEvents.length = 0;

  const clock = new FixedClock('2026-08-16T00:00:00Z'); // 15 jours restants sur 30
  const subscriptionAuditTrail = new InMemorySubscriptionAuditTrail();
  const handler = new UpgradeSubscriptionPlanHandler(
    planRepository,
    planPriceRepository,
    subscriptionRepository,
    planUpgradeRequestRepository,
    unitOfWork,
    clock,
    idGenerator,
    subscriptionAuditTrail,
  );

  return {
    planRepository,
    planPriceRepository,
    subscriptionRepository,
    planChangeRepository,
    planUpgradeRequestRepository,
    unitOfWork,
    clock,
    subscriptionAuditTrail,
    handler,
    standard,
    professionnel,
    complet,
    tenantId,
    subscriptionId: subscription.id,
  };
}

/**
 * Suite REECRITE pour la passe 2. Ce que cette commande garantit a change de nature : elle ne
 * CHANGE plus le forfait, elle DEMANDE un upgrade payant. Les assertions portent donc desormais
 * sur ce qui N'ARRIVE PAS (aucune mutation du forfait, aucune ligne d'historique) autant que sur
 * ce qui arrive (une demande en attente + l'evenement qui declenchera la facture).
 */
describe('UpgradeSubscriptionPlanHandler — demande d_upgrade conditionnee au paiement', () => {
  it('proratise correctement et renvoie une demande PENDING_PAYMENT, sans jamais changer le forfait', async () => {
    const { handler, subscriptionRepository, tenantId, standard } = await buildScenario();

    const result = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'PROFESSIONNEL' });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().proratedAmountXof).toBe(10_000); // (55000-35000)*15/30
    expect(result.getValue().status).toBe('PENDING_PAYMENT');
    expect(result.getValue().expiresAt).toBe('2026-08-17T00:00:00.000Z'); // TTL 24h

    // LE point de la passe 2 : le forfait est INCHANGE tant que le paiement n'est pas confirme.
    const subscription = await subscriptionRepository.findByTenantId(tenantId);
    expect(subscription?.planId.equals(standard.plan.id)).toBe(true);
    expect(subscription?.currentPlanPriceId.equals(standard.price.id)).toBe(true);
    // La periode en cours n'est pas davantage touchee.
    expect(subscription?.periodEndsAt).toEqual(new Date('2026-08-31T00:00:00Z'));
  });

  it('n_ecrit AUCUNE ligne d_historique PlanChange a ce stade (elle appartient a l_application, apres paiement)', async () => {
    const { handler, planChangeRepository, tenantId, subscriptionId } = await buildScenario();

    await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'PROFESSIONNEL' });

    const history = await planChangeRepository.listBySubscriptionId(subscriptionId, tenantId);
    expect(history).toHaveLength(0);
  });

  it('emet SubscriptionUpgradeRequested (jamais SubscriptionPlanChanged) avec le planChangeId retourne', async () => {
    const { handler, subscriptionRepository, professionnel } = await buildScenario();

    const result = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'PROFESSIONNEL' });

    const events = subscriptionRepository.publishedEvents;
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('subscription.subscription.upgrade-requested');
    // Le planChangeId retourne a l'appelant EST la reference qui voyagera jusqu'a la facture puis
    // reviendra dans SaaSPaymentSucceeded — c'est tout le mecanisme de correlation (ADR-0003).
    expect(events[0]?.payload['planChangeId']).toBe(result.getValue().planChangeId);
    expect(events[0]?.payload['toPlanPriceId']).toBe(professionnel.price.id.toString());
    expect(events[0]?.payload['proratedAmountXof']).toBe(10_000);
  });

  it('persiste la demande en attente, retrouvable par l_abonnement', async () => {
    const { handler, planUpgradeRequestRepository, tenantId, subscriptionId } = await buildScenario();

    const result = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'PROFESSIONNEL' });

    const pending = await planUpgradeRequestRepository.findBySubscriptionId(subscriptionId, tenantId);
    expect(pending?.id.toString()).toBe(result.getValue().planChangeId);
    expect(pending?.proratedAmount.amount).toBe(10_000);
  });

  // Decision produit : l'upgrade proratise est reserve aux abonnements ACTIVE, avec un code
  // d'erreur UNIQUE pour les trois autres statuts.
  for (const status of ['TRIALING', 'GRACE_PERIOD', 'DEGRADED'] as const) {
    it(`refuse un upgrade depuis le statut ${status} (SUBSCRIPTION_NOT_UPGRADABLE), sans aucun effet`, async () => {
      const { handler, subscriptionRepository, planUpgradeRequestRepository } = await buildScenario(status);

      const result = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'PROFESSIONNEL' });

      expect(result.isFailure()).toBe(true);
      expect(result.getError()).toBe('SUBSCRIPTION_NOT_UPGRADABLE');
      expect(planUpgradeRequestRepository.count()).toBe(0);
      expect(subscriptionRepository.publishedEvents).toHaveLength(0);
    });
  }

  it('refuse une SECONDE demande tant que la premiere n_est ni payee ni expiree (UPGRADE_ALREADY_PENDING)', async () => {
    // Double-clic / double soumission : une seule facture d'upgrade doit exister a la fois.
    const { handler, planUpgradeRequestRepository } = await buildScenario();

    const first = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'PROFESSIONNEL' });
    expect(first.isSuccess()).toBe(true);

    const second = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'COMPLET' });

    expect(second.isFailure()).toBe(true);
    expect(second.getError()).toBe('UPGRADE_ALREADY_PENDING');
    expect(planUpgradeRequestRepository.count()).toBe(1);
  });

  it('autorise une NOUVELLE demande une fois la precedente EXPIREE (TTL 24h ecoule) : elle la remplace', async () => {
    const { handler, clock, planUpgradeRequestRepository, tenantId, subscriptionId } = await buildScenario();

    const first = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'PROFESSIONNEL' });
    expect(first.isSuccess()).toBe(true);

    // 25 heures plus tard : la premiere demande est abandonnee.
    clock.advanceTo('2026-08-17T01:00:00Z');
    const second = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'COMPLET' });

    expect(second.isSuccess()).toBe(true);
    expect(second.getValue().planChangeId).not.toBe(first.getValue().planChangeId);
    // Une seule demande subsiste : la nouvelle a REMPLACE l'expiree, elles ne coexistent jamais.
    expect(planUpgradeRequestRepository.count()).toBe(1);
    const pending = await planUpgradeRequestRepository.findBySubscriptionId(subscriptionId, tenantId);
    expect(pending?.id.toString()).toBe(second.getValue().planChangeId);
  });

  it("refuse un 'upgrade' vers un forfait de prix inferieur ou egal (NOT_AN_UPGRADE), sans creer de demande", async () => {
    const { handler, planUpgradeRequestRepository } = await buildScenario();

    const result = await handler.execute({ tenantId: TENANT_ID, targetPlanCode: 'STANDARD' });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('NOT_AN_UPGRADE');
    expect(planUpgradeRequestRepository.count()).toBe(0);
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
