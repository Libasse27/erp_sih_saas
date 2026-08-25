import { describe, expect, it } from 'vitest';
import { Money } from '../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { FixedClock, SequentialIdGenerator, uuidAt } from '../../../../test/payment/builders/testKit.js';
import { PlatformInvoice } from './PlatformInvoice.js';

function tenantId(): TenantId {
  return TenantId.create(uuidAt(1)).getValue();
}

function makeInvoice(): PlatformInvoice {
  return PlatformInvoice.issue({
    tenantId: tenantId(),
    subscriptionId: uuidAt(20),
    planPriceId: uuidAt(30),
    purpose: 'RENEWAL',
    amount: Money.fromXOF(35_000).getValue(),
    periodStartsAt: new Date('2026-09-01T00:00:00Z'),
    periodEndsAt: new Date('2026-10-01T00:00:00Z'),
    clock: new FixedClock('2026-08-24T10:00:00Z'),
    idGenerator: new SequentialIdGenerator(),
  });
}

describe('PlatformInvoice', () => {
  it('issue() cree une facture ISSUED, non payee', () => {
    const invoice = makeInvoice();
    expect(invoice.status).toBe('ISSUED');
    expect(invoice.paidAt).toBeNull();
  });

  it('markPaid() marque la facture PAID avec la date fournie', () => {
    const invoice = makeInvoice();
    const paidAt = new Date('2026-09-02T00:00:00Z');
    invoice.markPaid(paidAt);
    expect(invoice.status).toBe('PAID');
    expect(invoice.paidAt).toEqual(paidAt);
  });

  it('markPaid() est IDEMPOTENT : un second appel ne modifie pas paidAt', () => {
    const invoice = makeInvoice();
    invoice.markPaid(new Date('2026-09-02T00:00:00Z'));
    invoice.markPaid(new Date('2026-09-05T00:00:00Z'));
    expect(invoice.paidAt).toEqual(new Date('2026-09-02T00:00:00Z'));
  });

  it('issue() sans sourceReference explicite en pose une a null : une facture de renouvellement ne se rattache a aucun fait metier identifie', () => {
    expect(makeInvoice().sourceReference).toBeNull();
  });

  it('issue() conserve la sourceReference opaque telle quelle, sans l_interpreter', () => {
    // Ce module ne sait pas que cette chaine designe un changement de forfait cote `subscription` :
    // il la stocke et la restituera dans SaaSPaymentSucceeded (voir ADR-0003).
    const invoice = PlatformInvoice.issue({
      tenantId: tenantId(),
      subscriptionId: uuidAt(20),
      planPriceId: uuidAt(30),
      purpose: 'UPGRADE',
      sourceReference: uuidAt(99),
      amount: Money.fromXOF(10_000).getValue(),
      periodStartsAt: new Date('2026-09-16T00:00:00Z'),
      periodEndsAt: new Date('2026-10-01T00:00:00Z'),
      clock: new FixedClock('2026-09-16T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    expect(invoice.purpose).toBe('UPGRADE');
    expect(invoice.sourceReference).toBe(uuidAt(99));
  });
});
