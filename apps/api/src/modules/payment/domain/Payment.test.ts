import { describe, expect, it } from 'vitest';
import { Money } from '../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { FixedClock, SequentialIdGenerator, uuidAt } from '../../../../test/payment/builders/testKit.js';
import { Payment } from './Payment.js';
import { PlatformInvoiceId } from './value-objects/PlatformInvoiceId.js';

function tenantId(): TenantId {
  return TenantId.create(uuidAt(1)).getValue();
}

function invoiceId(counter: number): PlatformInvoiceId {
  return PlatformInvoiceId.create(uuidAt(counter)).getValue();
}

function makePayment(params: { purpose?: 'INITIAL' | 'RENEWAL' | 'UPGRADE'; providerTransactionId?: string } = {}): Payment {
  return Payment.initiate({
    tenantId: tenantId(),
    platformInvoiceId: invoiceId(10),
    subscriptionId: uuidAt(20),
    purpose: params.purpose ?? 'RENEWAL',
    method: 'MOBILE_MONEY',
    amount: Money.fromXOF(35_000).getValue(),
    providerTransactionId: params.providerTransactionId ?? 'tx-1',
    clock: new FixedClock('2026-08-24T10:00:00Z'),
    idGenerator: new SequentialIdGenerator(),
  });
}

/**
 * Arguments de `confirmSucceeded()` communs a tous les cas testes ici. `sourceReference: null` :
 * ces scenarios portent tous sur des paiements de renouvellement, dont la facture n'en porte
 * aucune (voir PlatformInvoice.ts) — sa propagation dans l'evenement est verifiee separement, avec
 * une valeur non nulle.
 */
const NEW_PERIOD = {
  newPeriodStartsAt: new Date('2026-09-01T00:00:00Z'),
  newPeriodEndsAt: new Date('2026-10-01T00:00:00Z'),
  sourceReference: null,
};

describe('Payment', () => {
  it('initiate() cree un Payment PENDING', () => {
    const payment = makePayment();
    expect(payment.status).toBe('PENDING');
    expect(payment.confirmedAt).toBeNull();
  });

  it('confirmSucceeded() avec purpose RENEWAL passe au statut RENEWED (nuance signalee a l_architecte, PaymentStatus.ts)', () => {
    const payment = makePayment({ purpose: 'RENEWAL', providerTransactionId: 'tx-1' });
    payment.confirmSucceeded({
      providerTransactionId: 'tx-1',
      confirmedAt: new Date('2026-09-01T00:05:00Z'),
      ...NEW_PERIOD,
      clock: new FixedClock('2026-09-01T00:05:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    expect(payment.status).toBe('RENEWED');
  });

  it('confirmSucceeded() avec purpose INITIAL passe au statut SUCCEEDED', () => {
    const payment = makePayment({ purpose: 'INITIAL', providerTransactionId: 'tx-1' });
    payment.confirmSucceeded({
      providerTransactionId: 'tx-1',
      confirmedAt: new Date('2026-09-01T00:05:00Z'),
      ...NEW_PERIOD,
      clock: new FixedClock('2026-09-01T00:05:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    expect(payment.status).toBe('SUCCEEDED');
  });

  it('confirmSucceeded() emet SaaSPaymentSucceeded avec les identifiants corrects', () => {
    const payment = makePayment({ providerTransactionId: 'tx-1' });
    payment.confirmSucceeded({
      providerTransactionId: 'tx-1',
      confirmedAt: new Date('2026-09-01T00:05:00Z'),
      ...NEW_PERIOD,
      clock: new FixedClock('2026-09-01T00:05:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    const events = payment.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('payment.payment.saas-payment-succeeded');
    const event = events[0] as unknown as { providerTransactionId: string; subscriptionId: string };
    expect(event.providerTransactionId).toBe('tx-1');
    expect(event.subscriptionId).toBe(payment.subscriptionId);
  });

  it('confirmSucceeded() propage purpose (depuis le Payment) et sourceReference (fourni par l_appelant) dans SaaSPaymentSucceeded', () => {
    // Ces deux champs sont l'UNIQUE fil permettant au module `subscription` de rattacher un
    // paiement confirme a la demande d'upgrade precise qu'il regle (voir ADR-0003) : ils doivent
    // traverser l'evenement intacts, sans etre recalcules ni devines.
    const payment = makePayment({ purpose: 'UPGRADE', providerTransactionId: 'tx-upgrade' });
    payment.confirmSucceeded({
      providerTransactionId: 'tx-upgrade',
      confirmedAt: new Date('2026-09-01T00:05:00Z'),
      newPeriodStartsAt: new Date('2026-09-01T00:00:00Z'),
      newPeriodEndsAt: new Date('2026-10-01T00:00:00Z'),
      sourceReference: uuidAt(77),
      clock: new FixedClock('2026-09-01T00:05:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    const events = payment.pullDomainEvents();
    const event = events[0] as unknown as { purpose: string; sourceReference: string | null };
    expect(event.purpose).toBe('UPGRADE');
    expect(event.sourceReference).toBe(uuidAt(77));
    // `UPGRADE` n'est pas un renouvellement : le statut terminal est SUCCEEDED, pas RENEWED.
    expect(payment.status).toBe('SUCCEEDED');
  });

  // --- Adversarial : webhook recu 2 fois (idempotence) ---
  it('confirmSucceeded() appele deux fois pour le meme providerTransactionId est IDEMPOTENT (pas de second evenement)', () => {
    const payment = makePayment({ providerTransactionId: 'tx-1' });
    const params = {
      providerTransactionId: 'tx-1',
      confirmedAt: new Date('2026-09-01T00:05:00Z'),
      ...NEW_PERIOD,
      clock: new FixedClock('2026-09-01T00:05:00Z'),
      idGenerator: new SequentialIdGenerator(),
    };
    payment.confirmSucceeded(params);
    payment.pullDomainEvents();

    payment.confirmSucceeded(params);
    const secondCallEvents = payment.pullDomainEvents();

    expect(payment.status).toBe('RENEWED');
    expect(secondCallEvents).toHaveLength(0);
  });

  // --- Adversarial : SUCCEEDED puis notification dupliquee ---
  it('une notification SUCCEEDED dupliquee APRES traitement ne cree aucun effet de bord supplementaire', () => {
    const payment = makePayment({ providerTransactionId: 'tx-1' });
    payment.confirmSucceeded({
      providerTransactionId: 'tx-1',
      confirmedAt: new Date('2026-09-01T00:05:00Z'),
      ...NEW_PERIOD,
      clock: new FixedClock('2026-09-01T00:05:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    const firstConfirmedAt = payment.confirmedAt;
    payment.pullDomainEvents();

    payment.confirmSucceeded({
      providerTransactionId: 'tx-1',
      confirmedAt: new Date('2026-09-01T05:00:00Z'), // date differente, simule une redelivrance tardive
      ...NEW_PERIOD,
      clock: new FixedClock('2026-09-01T05:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    expect(payment.confirmedAt).toEqual(firstConfirmedAt); // pas ecrase
    expect(payment.pullDomainEvents()).toHaveLength(0);
  });

  // --- Adversarial : webhook recu dans le mauvais ordre (SUCCEEDED avant, FAILED apres) ---
  it('un FAILED tardif APRES un SUCCEEDED deja confirme est ignore (succes TERMINAL, jamais retrograde)', () => {
    const payment = makePayment({ providerTransactionId: 'tx-1' });
    payment.confirmSucceeded({
      providerTransactionId: 'tx-1',
      confirmedAt: new Date('2026-09-01T00:05:00Z'),
      ...NEW_PERIOD,
      clock: new FixedClock('2026-09-01T00:05:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    payment.confirmFailed({ providerTransactionId: 'tx-1' });

    expect(payment.status).toBe('RENEWED');
  });

  // --- Adversarial : FAILED puis SUCCEEDED pour la meme tentative ---
  it('un SUCCEEDED recu APRES un FAILED anterieur (meme tentative) est accepte (webhook tardif, O-25.6 "a tout moment")', () => {
    const payment = makePayment({ purpose: 'INITIAL', providerTransactionId: 'tx-1' });
    payment.confirmFailed({ providerTransactionId: 'tx-1' });
    expect(payment.status).toBe('FAILED');

    payment.confirmSucceeded({
      providerTransactionId: 'tx-1',
      confirmedAt: new Date('2026-09-01T00:05:00Z'),
      ...NEW_PERIOD,
      clock: new FixedClock('2026-09-01T00:05:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    expect(payment.status).toBe('SUCCEEDED');
  });

  // --- Adversarial : paiement confirme apres echeance (EXPIRED -> SUCCEEDED) ---
  it('un SUCCEEDED recu APRES expiration (markExpired) est accepte (paiement confirme apres echeance)', () => {
    const payment = makePayment({ purpose: 'INITIAL', providerTransactionId: 'tx-1' });
    payment.markExpired();
    expect(payment.status).toBe('EXPIRED');

    payment.confirmSucceeded({
      providerTransactionId: 'tx-1',
      confirmedAt: new Date('2026-09-01T00:05:00Z'),
      ...NEW_PERIOD,
      clock: new FixedClock('2026-09-01T00:05:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    expect(payment.status).toBe('SUCCEEDED');
  });

  it('markExpired() est idempotent et ne retrograde jamais un succes terminal', () => {
    const payment = makePayment({ purpose: 'INITIAL', providerTransactionId: 'tx-1' });
    payment.confirmSucceeded({
      providerTransactionId: 'tx-1',
      confirmedAt: new Date('2026-09-01T00:05:00Z'),
      ...NEW_PERIOD,
      clock: new FixedClock('2026-09-01T00:05:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    payment.markExpired();

    expect(payment.status).toBe('SUCCEEDED');
  });

  it('confirmSucceeded() leve une exception si le providerTransactionId ne correspond pas (bug applicatif)', () => {
    const payment = makePayment({ providerTransactionId: 'tx-1' });
    expect(() =>
      payment.confirmSucceeded({
        providerTransactionId: 'tx-AUTRE',
        confirmedAt: new Date('2026-09-01T00:05:00Z'),
        ...NEW_PERIOD,
        clock: new FixedClock('2026-09-01T00:05:00Z'),
        idGenerator: new SequentialIdGenerator(),
      }),
    ).toThrow();
  });
});
