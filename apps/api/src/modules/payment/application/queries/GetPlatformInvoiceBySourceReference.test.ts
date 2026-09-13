import { describe, expect, it } from 'vitest';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryPlatformInvoiceRepository,
  SequentialIdGenerator,
  mustFail,
  mustSucceed,
  uuidAt,
} from '../../../../../test/payment/builders/testKit.js';
import { PlatformInvoice } from '../../domain/PlatformInvoice.js';
import { GetPlatformInvoiceBySourceReferenceHandler } from './GetPlatformInvoiceBySourceReference.js';

const TENANT = TenantId.create(uuidAt(1)).getValue();
const OTHER_TENANT = TenantId.create(uuidAt(2)).getValue();
const CLOCK = new FixedClock('2026-08-24T10:00:00Z');

async function buildScenario() {
  const invoiceRepository = new InMemoryPlatformInvoiceRepository();
  const idGenerator = new SequentialIdGenerator();

  const invoice = PlatformInvoice.issue({
    tenantId: TENANT,
    subscriptionId: uuidAt(20),
    planPriceId: uuidAt(30),
    purpose: 'UPGRADE',
    sourceReference: 'plan-change-1',
    amount: Money.fromXOF(12_000).getValue(),
    periodStartsAt: new Date('2026-09-01T00:00:00Z'),
    periodEndsAt: new Date('2026-10-01T00:00:00Z'),
    clock: CLOCK,
    idGenerator,
  });
  await invoiceRepository.issue(invoice);

  const handler = new GetPlatformInvoiceBySourceReferenceHandler(invoiceRepository);

  return { invoiceRepository, handler, invoice, idGenerator };
}

describe('GetPlatformInvoiceBySourceReferenceHandler', () => {
  it('cas nominal : renvoie le DTO de la facture correspondant a la reference', async () => {
    const { handler, invoice } = await buildScenario();

    const result = await handler.execute('plan-change-1', TENANT.toString());

    const value = mustSucceed(result);
    expect(value).toEqual({
      platformInvoiceId: invoice.id.toString(),
      amountXof: 12_000,
      status: 'ISSUED',
    });
  });

  it('reference inconnue : renvoie null (jamais une erreur)', async () => {
    const { handler } = await buildScenario();

    const result = await handler.execute('reference-inconnue', TENANT.toString());

    expect(mustSucceed(result)).toBeNull();
  });

  it('isolation tenant : une facture d_un AUTRE tenant portant la MEME reference est invisible (null)', async () => {
    const { handler } = await buildScenario();

    const result = await handler.execute('plan-change-1', OTHER_TENANT.toString());

    expect(mustSucceed(result)).toBeNull();
  });

  it('rejette un tenantId invalide (INVALID_TENANT_ID)', async () => {
    const { handler } = await buildScenario();

    const result = await handler.execute('plan-change-1', 'pas-un-uuid');

    expect(mustFail(result)).toBe('INVALID_TENANT_ID');
  });
});
