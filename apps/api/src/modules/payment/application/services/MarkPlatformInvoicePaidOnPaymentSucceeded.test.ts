import { describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryBillingAuditTrail,
  InMemoryPlatformInvoiceRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/payment/builders/testKit.js';
import { PlatformInvoice } from '../../domain/PlatformInvoice.js';
import { createMarkPlatformInvoicePaidOnPaymentSucceededHandler } from './MarkPlatformInvoicePaidOnPaymentSucceeded.js';

const TENANT = TenantId.create(uuidAt(1)).getValue();
const CLOCK = new FixedClock('2026-08-24T10:00:00Z');

function envelope(overrides: Partial<OutboxEventEnvelope> = {}): OutboxEventEnvelope {
  return {
    id: uuidAt(2),
    eventType: 'payment.payment.saas-payment-succeeded',
    eventVersion: 1,
    aggregateId: uuidAt(5),
    tenantId: TENANT.toString(),
    occurredAt: new Date('2026-08-24T10:00:00Z'),
    payload: {
      tenantId: TENANT.toString(),
      platformInvoiceId: '',
    },
    ...overrides,
  };
}

async function build() {
  const invoiceRepository = new InMemoryPlatformInvoiceRepository();
  const billingAuditTrail = new InMemoryBillingAuditTrail();
  const unitOfWork = new InMemoryUnitOfWork();
  const idGenerator = new SequentialIdGenerator();

  const invoice = PlatformInvoice.issue({
    tenantId: TENANT,
    subscriptionId: uuidAt(20),
    planPriceId: uuidAt(30),
    purpose: 'RENEWAL',
    amount: Money.fromXOF(35_000).getValue(),
    periodStartsAt: new Date('2026-09-01T00:00:00Z'),
    periodEndsAt: new Date('2026-10-01T00:00:00Z'),
    clock: CLOCK,
    idGenerator,
  });
  await invoiceRepository.issue(invoice);

  const handler = createMarkPlatformInvoicePaidOnPaymentSucceededHandler({
    platformInvoiceRepository: invoiceRepository,
    billingAuditTrail,
    unitOfWork,
    clock: CLOCK,
  });

  return { invoiceRepository, billingAuditTrail, handler, invoice };
}

describe('MarkPlatformInvoicePaidOnPaymentSucceeded', () => {
  it('cas nominal : marque la PlatformInvoice PAID et enregistre une entree d_audit', async () => {
    const { invoiceRepository, billingAuditTrail, handler, invoice } = await build();

    await handler(envelope({ payload: { tenantId: TENANT.toString(), platformInvoiceId: invoice.id.toString() } }));

    const stored = await invoiceRepository.findById(invoice.id, TENANT);
    expect(stored?.status).toBe('PAID');
    expect(billingAuditTrail.records).toHaveLength(1);
    expect(billingAuditTrail.records[0]?.eventType).toBe('BILLING_PLATFORM_INVOICE_SETTLED');
  });

  it('redelivrance (meme evenement) : idempotent, une seule entree d_audit', async () => {
    const { billingAuditTrail, handler, invoice } = await build();
    const event = envelope({ payload: { tenantId: TENANT.toString(), platformInvoiceId: invoice.id.toString() } });

    await handler(event);
    await handler({ ...event, id: uuidAt(3) });

    expect(billingAuditTrail.records).toHaveLength(1);
  });

  it('PlatformInvoice introuvable (ex. hors tenant) : ignore silencieusement, aucun effet de bord', async () => {
    const { billingAuditTrail, handler } = await build();

    await handler(envelope({ payload: { tenantId: TENANT.toString(), platformInvoiceId: uuidAt(999) } }));

    expect(billingAuditTrail.records).toHaveLength(0);
  });

  it('payload invalide (champ manquant) -> leve une erreur', async () => {
    const { handler } = await build();

    await expect(handler(envelope({ payload: { tenantId: TENANT.toString() } }))).rejects.toThrow(/Payload invalide/);
  });

  it('identifiants invalides (tenantId ou platformInvoiceId) -> leve une erreur', async () => {
    const { handler } = await build();

    await expect(
      handler(envelope({ payload: { tenantId: 'pas-un-uuid', platformInvoiceId: uuidAt(5) } })),
    ).rejects.toThrow(/Identifiants invalides/);
  });
});
