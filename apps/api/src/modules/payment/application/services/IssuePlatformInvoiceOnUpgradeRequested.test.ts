import { describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryBillingAuditTrail,
  InMemoryPlatformInvoiceRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/payment/builders/testKit.js';
import { PlatformInvoiceId } from '../../domain/value-objects/PlatformInvoiceId.js';
import { createIssuePlatformInvoiceOnUpgradeRequestedHandler } from './IssuePlatformInvoiceOnUpgradeRequested.js';

const TENANT = uuidAt(1);
const SUBSCRIPTION_ID = uuidAt(20);
const PLAN_CHANGE_ID = uuidAt(40);
const CLOCK = new FixedClock('2026-08-24T10:00:00Z');

function envelope(overrides: Partial<OutboxEventEnvelope> = {}): OutboxEventEnvelope {
  return {
    id: uuidAt(2),
    eventType: 'subscription.subscription.upgrade-requested',
    eventVersion: 1,
    aggregateId: SUBSCRIPTION_ID,
    tenantId: TENANT,
    occurredAt: new Date('2026-08-24T10:00:00Z'),
    payload: {
      tenantId: TENANT,
      planChangeId: PLAN_CHANGE_ID,
      toPlanPriceId: uuidAt(30),
      proratedAmountXof: 12_000,
      coveredPeriodStartsAt: '2026-08-24T00:00:00Z',
      coveredPeriodEndsAt: '2026-09-01T00:00:00Z',
    },
    ...overrides,
  };
}

function build() {
  const invoiceRepository = new InMemoryPlatformInvoiceRepository();
  const billingAuditTrail = new InMemoryBillingAuditTrail();
  const unitOfWork = new InMemoryUnitOfWork();
  const idGenerator = new SequentialIdGenerator();
  const handler = createIssuePlatformInvoiceOnUpgradeRequestedHandler({
    platformInvoiceRepository: invoiceRepository,
    billingAuditTrail,
    unitOfWork,
    clock: CLOCK,
    idGenerator,
  });
  return { invoiceRepository, billingAuditTrail, handler };
}

describe('IssuePlatformInvoiceOnUpgradeRequested', () => {
  it('cas nominal : emet une PlatformInvoice UPGRADE proratisee, portant la reference du changement de forfait', async () => {
    const { invoiceRepository, billingAuditTrail, handler } = build();

    await handler(envelope());

    expect(billingAuditTrail.records).toHaveLength(1);
    const invoiceId = PlatformInvoiceId.create(billingAuditTrail.records[0]!.targetId).getValue();
    const invoice = await invoiceRepository.findById(invoiceId, TenantId.create(TENANT).getValue());
    expect(invoice?.purpose).toBe('UPGRADE');
    expect(invoice?.sourceReference).toBe(PLAN_CHANGE_ID);
    expect(invoice?.amount.amount).toBe(12_000);
  });

  it('montant proratise a ZERO reste emis comme une facture normale', async () => {
    const { invoiceRepository, billingAuditTrail, handler } = build();

    await handler(envelope({ payload: { tenantId: TENANT, planChangeId: PLAN_CHANGE_ID, toPlanPriceId: uuidAt(30), proratedAmountXof: 0, coveredPeriodStartsAt: '2026-08-24T00:00:00Z', coveredPeriodEndsAt: '2026-09-01T00:00:00Z' } }));

    const invoiceId = PlatformInvoiceId.create(billingAuditTrail.records[0]!.targetId).getValue();
    const invoice = await invoiceRepository.findById(invoiceId, TenantId.create(TENANT).getValue());
    expect(invoice?.amount.amount).toBe(0);
  });

  it('redelivrance (meme planChangeId) : idempotent (contrainte source_reference), une seule entree d_audit', async () => {
    const { billingAuditTrail, handler } = build();

    await handler(envelope());
    await handler(envelope({ id: uuidAt(3) }));

    expect(billingAuditTrail.records).toHaveLength(1);
  });

  it('payload invalide (champ manquant) -> leve une erreur', async () => {
    const { handler } = build();

    await expect(handler(envelope({ payload: { tenantId: TENANT } }))).rejects.toThrow(/Payload invalide/);
  });

  it('tenantId invalide dans le payload -> leve une erreur', async () => {
    const { handler } = build();

    await expect(
      handler(
        envelope({
          payload: {
            tenantId: 'pas-un-uuid',
            planChangeId: PLAN_CHANGE_ID,
            toPlanPriceId: uuidAt(30),
            proratedAmountXof: 12_000,
            coveredPeriodStartsAt: '2026-08-24T00:00:00Z',
            coveredPeriodEndsAt: '2026-09-01T00:00:00Z',
          },
        }),
      ),
    ).rejects.toThrow(/tenantId invalide/);
  });
});
