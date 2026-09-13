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
import { createIssuePlatformInvoiceOnRenewalDueHandler } from './IssuePlatformInvoiceOnRenewalDue.js';

const TENANT = uuidAt(1);
const SUBSCRIPTION_ID = uuidAt(20);
const CLOCK = new FixedClock('2026-08-24T10:00:00Z');

function envelope(overrides: Partial<OutboxEventEnvelope> = {}): OutboxEventEnvelope {
  return {
    id: uuidAt(2),
    eventType: 'subscription.subscription.renewal-due',
    eventVersion: 1,
    aggregateId: SUBSCRIPTION_ID,
    tenantId: TENANT,
    occurredAt: new Date('2026-08-24T10:00:00Z'),
    payload: {
      tenantId: TENANT,
      planPriceId: uuidAt(30),
      amountXof: 35_000,
      newPeriodStartsAt: '2026-09-01T00:00:00Z',
      newPeriodEndsAt: '2026-10-01T00:00:00Z',
    },
    ...overrides,
  };
}

function build() {
  const invoiceRepository = new InMemoryPlatformInvoiceRepository();
  const billingAuditTrail = new InMemoryBillingAuditTrail();
  const unitOfWork = new InMemoryUnitOfWork();
  const idGenerator = new SequentialIdGenerator();
  const handler = createIssuePlatformInvoiceOnRenewalDueHandler({
    platformInvoiceRepository: invoiceRepository,
    billingAuditTrail,
    unitOfWork,
    clock: CLOCK,
    idGenerator,
  });
  return { invoiceRepository, billingAuditTrail, handler };
}

describe('IssuePlatformInvoiceOnRenewalDue', () => {
  it('cas nominal : emet une PlatformInvoice RENEWAL et enregistre une entree d_audit', async () => {
    const { invoiceRepository, billingAuditTrail, handler } = build();

    await handler(envelope());

    expect(billingAuditTrail.records).toHaveLength(1);
    expect(billingAuditTrail.records[0]?.eventType).toBe('BILLING_PLATFORM_INVOICE_ISSUED');
    const invoiceId = PlatformInvoiceId.create(billingAuditTrail.records[0]!.targetId).getValue();
    const invoice = await invoiceRepository.findById(invoiceId, TenantId.create(TENANT).getValue());
    expect(invoice?.purpose).toBe('RENEWAL');
    expect(invoice?.amount.amount).toBe(35_000);
    expect(invoice?.sourceReference).toBeNull();
  });

  it('redelivrance (meme periode) : idempotent, une seule entree d_audit', async () => {
    const { billingAuditTrail, handler } = build();

    await handler(envelope());
    await handler(envelope({ id: uuidAt(3) }));

    expect(billingAuditTrail.records).toHaveLength(1);
  });

  it('payload invalide (champ manquant) -> leve une erreur, message explicite', async () => {
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
            planPriceId: uuidAt(30),
            amountXof: 35_000,
            newPeriodStartsAt: '2026-09-01T00:00:00Z',
            newPeriodEndsAt: '2026-10-01T00:00:00Z',
          },
        }),
      ),
    ).rejects.toThrow(/tenantId invalide/);
  });
});
