import { describe, expect, it } from 'vitest';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryPaymentProvider,
  InMemoryPaymentRepository,
  InMemoryPlatformInvoiceRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  mustFail,
  mustSucceed,
  uuidAt,
} from '../../../../../test/payment/builders/testKit.js';
import { PlatformInvoice } from '../../domain/PlatformInvoice.js';
import { InitiatePaymentHandler } from './InitiatePayment.js';

const TENANT = TenantId.create(uuidAt(1)).getValue();
const OTHER_TENANT = TenantId.create(uuidAt(2)).getValue();
const CLOCK = new FixedClock('2026-08-24T10:00:00Z');

async function buildScenario() {
  const paymentRepository = new InMemoryPaymentRepository();
  const invoiceRepository = new InMemoryPlatformInvoiceRepository();
  const provider = new InMemoryPaymentProvider();
  const unitOfWork = new InMemoryUnitOfWork();
  const idGenerator = new SequentialIdGenerator();

  const invoice = PlatformInvoice.issue({
    tenantId: TENANT,
    subscriptionId: uuidAt(20),
    planPriceId: uuidAt(30),
    amount: Money.fromXOF(35_000).getValue(),
    periodStartsAt: new Date('2026-09-01T00:00:00Z'),
    periodEndsAt: new Date('2026-10-01T00:00:00Z'),
    clock: CLOCK,
    idGenerator,
  });
  await invoiceRepository.issue(invoice);

  const handler = new InitiatePaymentHandler(invoiceRepository, paymentRepository, provider, unitOfWork, CLOCK, idGenerator);

  return { paymentRepository, invoiceRepository, provider, handler, invoice };
}

describe('InitiatePaymentHandler', () => {
  it('cas nominal : initie un Payment PENDING avec un providerTransactionId fourni par le prestataire', async () => {
    const { handler, invoice, paymentRepository } = await buildScenario();

    const result = await handler.execute({ tenantId: TENANT.toString(), platformInvoiceId: invoice.id.toString(), method: 'MOBILE_MONEY' });

    const value = mustSucceed(result);
    expect(value.providerTransactionId).toMatch(/^fake_tx_/);
    const stored = await paymentRepository.findById(
      (await paymentRepository.findByProviderTransactionId(value.providerTransactionId))!.id,
      TENANT,
    );
    expect(stored?.status).toBe('PENDING');
    expect(stored?.method).toBe('MOBILE_MONEY');
  });

  it('rejette une facture inexistante (INVOICE_NOT_FOUND)', async () => {
    const { handler } = await buildScenario();
    const result = await handler.execute({ tenantId: TENANT.toString(), platformInvoiceId: uuidAt(999), method: 'CARD' });
    expect(mustFail(result)).toBe('INVOICE_NOT_FOUND');
  });

  it('isolation tenant : une facture d_un AUTRE tenant est invisible (404 logique, INVOICE_NOT_FOUND)', async () => {
    const { handler, invoice } = await buildScenario();
    const result = await handler.execute({ tenantId: OTHER_TENANT.toString(), platformInvoiceId: invoice.id.toString(), method: 'CARD' });
    expect(mustFail(result)).toBe('INVOICE_NOT_FOUND');
  });

  it('rejette une facture DEJA PAYEE (INVOICE_ALREADY_PAID)', async () => {
    const { handler, invoice, invoiceRepository } = await buildScenario();
    invoice.markPaid(new Date('2026-09-05T00:00:00Z'));
    await invoiceRepository.save(invoice, TENANT);

    const result = await handler.execute({ tenantId: TENANT.toString(), platformInvoiceId: invoice.id.toString(), method: 'MOBILE_MONEY' });
    expect(mustFail(result)).toBe('INVOICE_ALREADY_PAID');
  });

  it('rejette un moyen de paiement invalide (INVALID_METHOD) — le virement, notamment, est inexprimable ici (O-25.2)', async () => {
    const { handler, invoice } = await buildScenario();
    const result = await handler.execute({ tenantId: TENANT.toString(), platformInvoiceId: invoice.id.toString(), method: 'VIREMENT' });
    expect(mustFail(result)).toBe('INVALID_METHOD');
  });

  it('rejette un tenantId invalide (INVALID_TENANT_ID)', async () => {
    const { handler, invoice } = await buildScenario();
    const result = await handler.execute({ tenantId: 'pas-un-uuid', platformInvoiceId: invoice.id.toString(), method: 'CARD' });
    expect(mustFail(result)).toBe('INVALID_TENANT_ID');
  });
});
