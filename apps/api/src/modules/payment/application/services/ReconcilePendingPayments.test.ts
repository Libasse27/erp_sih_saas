import { describe, expect, it } from 'vitest';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PaymentId } from '../../domain/value-objects/PaymentId.js';
import {
  FixedClock,
  InMemoryPaymentProvider,
  InMemoryPaymentRepository,
  InMemoryPlatformInvoiceRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/payment/builders/testKit.js';
import { Payment } from '../../domain/Payment.js';
import { PlatformInvoice } from '../../domain/PlatformInvoice.js';
import { PlatformInvoiceId } from '../../domain/value-objects/PlatformInvoiceId.js';
import { PaymentConcurrencyConflictError } from '../../domain/ports/PaymentRepository.js';
import { ReconcilePendingPaymentsHandler } from './ReconcilePendingPayments.js';

const TENANT = TenantId.create(uuidAt(1)).getValue();
/** `now` de reference pour tous les scenarios : reconcileThreshold = 09:55:00Z, expireThreshold = 09:00:00Z. */
const NOW_ISO = '2026-08-24T10:00:00Z';
const CLOCK = new FixedClock(NOW_ISO);

/**
 * Double de `InMemoryPaymentRepository` outille pour simuler, de maniere DETERMINISTE, les deux
 * conditions de course documentees dans `ReconcilePendingPayments.ts` (candidat disparu entre le
 * listing et la transaction ; conflit de verrouillage optimiste sur `save()`) — aucun fake
 * existant du testKit partage ne les couvre, elles sont donc ajoutees localement a ce fichier de
 * test uniquement.
 */
class FlakyPaymentRepository extends InMemoryPaymentRepository {
  private readonly failSaveTimes = new Map<string, number>();
  private readonly nullOnFindByIdCall = new Map<string, number>();
  private readonly findByIdCallCount = new Map<string, number>();

  failSaveNTimes(id: string, times: number): void {
    this.failSaveTimes.set(id, times);
  }

  returnNullOnFindByIdCall(id: string, callIndex: number): void {
    this.nullOnFindByIdCall.set(id, callIndex);
  }

  override async findById(id: PaymentId, tenantId: TenantId): Promise<Payment | null> {
    const key = id.toString();
    const count = (this.findByIdCallCount.get(key) ?? 0) + 1;
    this.findByIdCallCount.set(key, count);
    if (this.nullOnFindByIdCall.get(key) === count) {
      return null;
    }
    return super.findById(id, tenantId);
  }

  override async save(payment: Payment, tenantId: TenantId): Promise<void> {
    const key = payment.id.toString();
    const remaining = this.failSaveTimes.get(key) ?? 0;
    if (remaining > 0) {
      this.failSaveTimes.set(key, remaining - 1);
      throw new PaymentConcurrencyConflictError('Conflit de verrouillage optimiste simule (test).');
    }
    return super.save(payment, tenantId);
  }
}

interface Scenario {
  readonly paymentRepository: FlakyPaymentRepository;
  readonly invoiceRepository: InMemoryPlatformInvoiceRepository;
  readonly provider: InMemoryPaymentProvider;
  readonly handler: ReconcilePendingPaymentsHandler;
  readonly invoice: PlatformInvoice;
  readonly idGenerator: SequentialIdGenerator;
}

async function buildScenario(): Promise<Scenario> {
  const paymentRepository = new FlakyPaymentRepository();
  const invoiceRepository = new InMemoryPlatformInvoiceRepository();
  const provider = new InMemoryPaymentProvider();
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

  const handler = new ReconcilePendingPaymentsHandler(
    paymentRepository,
    invoiceRepository,
    provider,
    unitOfWork,
    CLOCK,
    idGenerator,
  );

  return { paymentRepository, invoiceRepository, provider, handler, invoice, idGenerator };
}

/** Cree un `Payment` PENDING dont `initiatedAt` est fixe independamment du `CLOCK` du scenario. */
function createPayment(params: {
  invoice: PlatformInvoice;
  providerTransactionId: string;
  initiatedAtIso: string;
  idGenerator: SequentialIdGenerator;
}): Payment {
  return Payment.initiate({
    tenantId: TENANT,
    platformInvoiceId: params.invoice.id,
    subscriptionId: params.invoice.subscriptionId,
    purpose: 'RENEWAL',
    method: 'MOBILE_MONEY',
    amount: params.invoice.amount,
    providerTransactionId: params.providerTransactionId,
    clock: new FixedClock(params.initiatedAtIso),
    idGenerator: params.idGenerator,
  });
}

describe('ReconcilePendingPaymentsHandler', () => {
  it('cas nominal : Payment PENDING ancien confirme SUCCEEDED cote prestataire est marque RENEWED', async () => {
    const { paymentRepository, provider, handler, invoice, idGenerator } = await buildScenario();
    const payment = createPayment({ invoice, providerTransactionId: 'tx-succeeded', initiatedAtIso: '2026-08-24T09:00:00Z', idGenerator });
    await paymentRepository.save(payment, TENANT);
    provider.simulateProviderOutcome('tx-succeeded', 'SUCCEEDED');

    const result = await handler.execute();

    expect(result).toEqual({ reconciled: 1, confirmedSucceeded: 1, confirmedFailed: 0, expired: 0 });
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('RENEWED');
  });

  it('Payment PENDING ancien confirme FAILED cote prestataire est marque FAILED', async () => {
    const { paymentRepository, provider, handler, invoice, idGenerator } = await buildScenario();
    const payment = createPayment({ invoice, providerTransactionId: 'tx-failed', initiatedAtIso: '2026-08-24T09:30:00Z', idGenerator });
    await paymentRepository.save(payment, TENANT);
    provider.simulateProviderOutcome('tx-failed', 'FAILED');

    const result = await handler.execute();

    expect(result).toEqual({ reconciled: 1, confirmedSucceeded: 0, confirmedFailed: 1, expired: 0 });
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('FAILED');
  });

  it('Payment toujours PENDING cote prestataire, pas assez ancien pour expirer : aucun changement applique', async () => {
    const { paymentRepository, provider, handler, invoice, idGenerator } = await buildScenario();
    const payment = createPayment({ invoice, providerTransactionId: 'tx-pending', initiatedAtIso: '2026-08-24T09:50:00Z', idGenerator });
    await paymentRepository.save(payment, TENANT);
    provider.simulateProviderOutcome('tx-pending', 'PENDING');

    const result = await handler.execute();

    expect(result).toEqual({ reconciled: 1, confirmedSucceeded: 0, confirmedFailed: 0, expired: 0 });
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('PENDING');
  });

  it('Payment PENDING trop ancien, sans confirmation ni echec du prestataire (NOT_FOUND), est marque EXPIRED', async () => {
    const { paymentRepository, handler, invoice, idGenerator } = await buildScenario();
    const payment = createPayment({ invoice, providerTransactionId: 'tx-expired-not-found', initiatedAtIso: '2026-08-24T08:30:00Z', idGenerator });
    await paymentRepository.save(payment, TENANT);
    // Aucune transaction simulee cote prestataire -> `reconcileTransaction` renvoie NOT_FOUND, la
    // meme branche que PENDING trop ancien (voir commentaire de ReconcilePendingPayments.ts).

    const result = await handler.execute();

    expect(result).toEqual({ reconciled: 1, confirmedSucceeded: 0, confirmedFailed: 0, expired: 1 });
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('EXPIRED');
  });

  it('incoherence detectee : PlatformInvoice introuvable pour un Payment SUCCEEDED cote prestataire -> erreur technique propagee', async () => {
    const { paymentRepository, provider, handler, idGenerator } = await buildScenario();
    const ghostInvoiceId = PlatformInvoiceId.create(uuidAt(999)).getValue();
    const payment = Payment.initiate({
      tenantId: TENANT,
      platformInvoiceId: ghostInvoiceId,
      subscriptionId: uuidAt(20),
      purpose: 'RENEWAL',
      method: 'MOBILE_MONEY',
      amount: Money.fromXOF(35_000).getValue(),
      providerTransactionId: 'tx-ghost',
      clock: new FixedClock('2026-08-24T09:00:00Z'),
      idGenerator,
    });
    await paymentRepository.save(payment, TENANT);
    provider.simulateProviderOutcome('tx-ghost', 'SUCCEEDED');

    await expect(handler.execute()).rejects.toThrow(/introuvable/);
  });

  it('candidat disparu entre le listing et la transaction : ignore silencieusement, aucune ecriture', async () => {
    const { paymentRepository, provider, handler, invoice, idGenerator } = await buildScenario();
    const payment = createPayment({ invoice, providerTransactionId: 'tx-vanish', initiatedAtIso: '2026-08-24T09:00:00Z', idGenerator });
    await paymentRepository.save(payment, TENANT);
    provider.simulateProviderOutcome('tx-vanish', 'SUCCEEDED');
    paymentRepository.returnNullOnFindByIdCall(payment.id.toString(), 1);

    const result = await handler.execute();

    expect(result).toEqual({ reconciled: 1, confirmedSucceeded: 0, confirmedFailed: 0, expired: 0 });
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('PENDING');
  });

  it('conflit de verrouillage optimiste transitoire : nouvelle tentative reussie apres relecture', async () => {
    const { paymentRepository, provider, handler, invoice, idGenerator } = await buildScenario();
    const payment = createPayment({ invoice, providerTransactionId: 'tx-retry-ok', initiatedAtIso: '2026-08-24T09:00:00Z', idGenerator });
    await paymentRepository.save(payment, TENANT);
    provider.simulateProviderOutcome('tx-retry-ok', 'SUCCEEDED');
    paymentRepository.failSaveNTimes(payment.id.toString(), 1);

    const result = await handler.execute();

    expect(result.confirmedSucceeded).toBe(1);
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('RENEWED');
  });

  it('conflits de verrouillage optimiste persistants : abandon apres epuisement des tentatives', async () => {
    const { paymentRepository, provider, handler, invoice, idGenerator } = await buildScenario();
    const payment = createPayment({ invoice, providerTransactionId: 'tx-retry-exhausted', initiatedAtIso: '2026-08-24T09:00:00Z', idGenerator });
    await paymentRepository.save(payment, TENANT);
    provider.simulateProviderOutcome('tx-retry-exhausted', 'SUCCEEDED');
    paymentRepository.failSaveNTimes(payment.id.toString(), 3);

    await expect(handler.execute()).rejects.toBeInstanceOf(PaymentConcurrencyConflictError);
  });

  it('conflit de verrouillage optimiste suivi d_une relecture introuvable : remonte l_erreur d_origine', async () => {
    const { paymentRepository, provider, handler, invoice, idGenerator } = await buildScenario();
    const payment = createPayment({ invoice, providerTransactionId: 'tx-reload-null', initiatedAtIso: '2026-08-24T09:00:00Z', idGenerator });
    await paymentRepository.save(payment, TENANT);
    provider.simulateProviderOutcome('tx-reload-null', 'SUCCEEDED');
    paymentRepository.failSaveNTimes(payment.id.toString(), 1);
    paymentRepository.returnNullOnFindByIdCall(payment.id.toString(), 2);

    await expect(handler.execute()).rejects.toBeInstanceOf(PaymentConcurrencyConflictError);
  });
});
