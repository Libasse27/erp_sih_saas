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
import { Payment } from '../../domain/Payment.js';
import { PlatformInvoice } from '../../domain/PlatformInvoice.js';
import { ConfirmPaymentHandler } from './ConfirmPayment.js';

const TENANT = TenantId.create(uuidAt(1)).getValue();
const CLOCK = new FixedClock('2026-08-24T10:00:00Z');
/** Montant de la facture/du Payment de `buildScenario()` — reutilise par tous les webhooks construits ci-dessous (le cas nominal doit porter le MEME montant que le Payment attendu). */
const PAYMENT_AMOUNT = Money.fromXOF(35_000).getValue();

interface Scenario {
  readonly paymentRepository: InMemoryPaymentRepository;
  readonly invoiceRepository: InMemoryPlatformInvoiceRepository;
  readonly provider: InMemoryPaymentProvider;
  readonly handler: ConfirmPaymentHandler;
  readonly payment: Payment;
  readonly invoice: PlatformInvoice;
}

async function buildScenario(params: { purpose?: 'INITIAL' | 'RENEWAL' } = {}): Promise<Scenario> {
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

  const payment = Payment.initiate({
    tenantId: TENANT,
    platformInvoiceId: invoice.id,
    subscriptionId: invoice.subscriptionId,
    purpose: params.purpose ?? 'RENEWAL',
    method: 'MOBILE_MONEY',
    amount: invoice.amount,
    providerTransactionId: 'tx-1',
    clock: CLOCK,
    idGenerator,
  });
  await paymentRepository.save(payment, TENANT);

  const handler = new ConfirmPaymentHandler(paymentRepository, invoiceRepository, provider, unitOfWork, CLOCK, idGenerator);

  return { paymentRepository, invoiceRepository, provider, handler, payment, invoice };
}

describe('ConfirmPaymentHandler', () => {
  it('cas nominal : webhook SUCCEEDED signe confirme le Payment', async () => {
    const { handler, provider, paymentRepository, payment } = await buildScenario();
    const webhook = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'SUCCEEDED', occurredAt: new Date('2026-09-01T00:05:00Z'), amount: PAYMENT_AMOUNT });

    const result = await handler.execute({ rawBody: webhook.rawBody, signatureHeader: webhook.signatureHeader });

    expect(mustSucceed(result).status).toBe('PROCESSED');
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('RENEWED');
  });

  it('webhook SANS signature -> rejet (INVALID_SIGNATURE), Payment reste PENDING (aucun effet de bord)', async () => {
    const { handler, provider, paymentRepository, payment } = await buildScenario();
    const webhook = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'SUCCEEDED', occurredAt: new Date(), amount: PAYMENT_AMOUNT });

    const result = await handler.execute({ rawBody: webhook.rawBody, signatureHeader: undefined });

    expect(mustFail(result)).toBe('INVALID_SIGNATURE');
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('PENDING');
  });

  it('webhook avec signature INVALIDE -> rejet (INVALID_SIGNATURE), Payment reste PENDING (aucun effet de bord)', async () => {
    const { handler, provider, paymentRepository, payment } = await buildScenario();
    const webhook = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'SUCCEEDED', occurredAt: new Date(), amount: PAYMENT_AMOUNT });

    const result = await handler.execute({ rawBody: webhook.rawBody, signatureHeader: 'signature-forgee' });

    expect(mustFail(result)).toBe('INVALID_SIGNATURE');
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('PENDING');
  });

  it(
    'ACTIVATION FRONTEND IMPOSSIBLE PAR CONSTRUCTION : un payload "succes" fabrique cote client, sans signature valide du prestataire, ne peut jamais faire passer le Payment en succes',
    async () => {
      const { handler, paymentRepository, payment } = await buildScenario();
      const forgedFrontendPayload = JSON.stringify({
        providerTransactionId: 'tx-1',
        outcome: 'SUCCEEDED',
        occurredAt: new Date().toISOString(),
      });

      const result = await handler.execute({ rawBody: forgedFrontendPayload, signatureHeader: undefined });

      expect(mustFail(result)).toBe('INVALID_SIGNATURE');
      const stored = await paymentRepository.findById(payment.id, TENANT);
      expect(stored?.status).toBe('PENDING');
    },
  );

  it('webhook recu 2 FOIS (meme providerTransactionId) est IDEMPOTENT : les deux appels reussissent, un seul effet applique', async () => {
    const { handler, provider, paymentRepository, payment } = await buildScenario();
    const webhook = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'SUCCEEDED', occurredAt: new Date('2026-09-01T00:05:00Z'), amount: PAYMENT_AMOUNT });

    const first = await handler.execute({ rawBody: webhook.rawBody, signatureHeader: webhook.signatureHeader });
    const second = await handler.execute({ rawBody: webhook.rawBody, signatureHeader: webhook.signatureHeader });

    expect(mustSucceed(first).status).toBe('PROCESSED');
    expect(mustSucceed(second).status).toBe('PROCESSED');
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('RENEWED');
  });

  it('providerTransactionId INCONNU -> rejet (UNKNOWN_TRANSACTION), sans fuite d_information', async () => {
    const { handler, provider } = await buildScenario();
    const webhook = provider.buildWebhook({ providerTransactionId: 'tx-INCONNU', outcome: 'SUCCEEDED', occurredAt: new Date(), amount: PAYMENT_AMOUNT });

    const result = await handler.execute({ rawBody: webhook.rawBody, signatureHeader: webhook.signatureHeader });

    expect(mustFail(result)).toBe('UNKNOWN_TRANSACTION');
  });

  it('webhook recu dans le MAUVAIS ORDRE : SUCCEEDED puis FAILED tardif -> le FAILED est ignore (succes terminal jamais retrograde)', async () => {
    const { handler, provider, paymentRepository, payment } = await buildScenario();
    const succeeded = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'SUCCEEDED', occurredAt: new Date('2026-09-01T00:05:00Z'), amount: PAYMENT_AMOUNT });
    const failedLate = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'FAILED', occurredAt: new Date('2026-09-01T00:06:00Z'), amount: PAYMENT_AMOUNT });

    await handler.execute({ rawBody: succeeded.rawBody, signatureHeader: succeeded.signatureHeader });
    const result = await handler.execute({ rawBody: failedLate.rawBody, signatureHeader: failedLate.signatureHeader });

    expect(mustSucceed(result).status).toBe('PROCESSED');
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('RENEWED');
  });

  it('FAILED puis SUCCEEDED pour la MEME tentative : le SUCCEEDED tardif est accepte (O-25.6, "a tout moment")', async () => {
    const { handler, provider, paymentRepository, payment } = await buildScenario();
    const failed = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'FAILED', occurredAt: new Date('2026-09-01T00:05:00Z'), amount: PAYMENT_AMOUNT });
    const succeededLate = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'SUCCEEDED', occurredAt: new Date('2026-09-01T02:00:00Z'), amount: PAYMENT_AMOUNT });

    await handler.execute({ rawBody: failed.rawBody, signatureHeader: failed.signatureHeader });
    let stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('FAILED');

    const result = await handler.execute({ rawBody: succeededLate.rawBody, signatureHeader: succeededLate.signatureHeader });

    expect(mustSucceed(result).status).toBe('PROCESSED');
    stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('RENEWED');
  });

  it('paiement CONFIRME APRES ECHEANCE (Payment deja EXPIRED) : le SUCCEEDED tardif est accepte', async () => {
    const { handler, provider, paymentRepository, payment } = await buildScenario();
    payment.markExpired();
    await paymentRepository.save(payment, TENANT);

    const webhook = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'SUCCEEDED', occurredAt: new Date('2026-10-15T00:00:00Z'), amount: PAYMENT_AMOUNT });
    const result = await handler.execute({ rawBody: webhook.rawBody, signatureHeader: webhook.signatureHeader });

    expect(mustSucceed(result).status).toBe('PROCESSED');
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('RENEWED');
  });

  it('SUCCEEDED puis notification DUPLIQUEE (meme providerTransactionId) apres traitement complet : aucun effet de bord supplementaire', async () => {
    const { handler, provider, paymentRepository, payment } = await buildScenario();
    const webhook = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'SUCCEEDED', occurredAt: new Date('2026-09-01T00:05:00Z'), amount: PAYMENT_AMOUNT });

    await handler.execute({ rawBody: webhook.rawBody, signatureHeader: webhook.signatureHeader });
    const afterFirst = await paymentRepository.findById(payment.id, TENANT);
    const confirmedAtAfterFirst = afterFirst?.confirmedAt;

    const duplicate = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'SUCCEEDED', occurredAt: new Date('2026-09-01T09:00:00Z'), amount: PAYMENT_AMOUNT });
    const result = await handler.execute({ rawBody: duplicate.rawBody, signatureHeader: duplicate.signatureHeader });

    expect(mustSucceed(result).status).toBe('PROCESSED');
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('RENEWED');
    expect(stored?.confirmedAt).toEqual(confirmedAtAfterFirst);
  });

  it('payload illisible (JSON malforme) apres signature valide -> rejet (INVALID_PAYLOAD)', async () => {
    const { handler, provider } = await buildScenario();
    const signatureHeader = provider.buildWebhook({ providerTransactionId: 'tx-1', outcome: 'SUCCEEDED', occurredAt: new Date(), amount: PAYMENT_AMOUNT }).signatureHeader;

    // Signature "valide" au sens du fake (constante) mais accompagnee d'un corps non-JSON —
    // demontre que la verification de signature et le parsing du payload sont deux etapes
    // distinctes, toutes deux necessaires.
    const result = await handler.execute({ rawBody: 'not-json', signatureHeader });

    expect(mustFail(result)).toBe('INVALID_PAYLOAD');
  });

  it('webhook SUCCEEDED avec un montant INFERIEUR au montant attendu -> rejet (AMOUNT_MISMATCH), Payment reste PENDING', async () => {
    const { handler, provider, paymentRepository, payment } = await buildScenario();
    const webhook = provider.buildWebhook({
      providerTransactionId: 'tx-1',
      outcome: 'SUCCEEDED',
      occurredAt: new Date('2026-09-01T00:05:00Z'),
      amount: Money.fromXOF(34_999).getValue(),
    });

    const result = await handler.execute({ rawBody: webhook.rawBody, signatureHeader: webhook.signatureHeader });

    expect(mustFail(result)).toBe('AMOUNT_MISMATCH');
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('PENDING');
  });

  it('webhook SUCCEEDED avec un montant SUPERIEUR au montant attendu -> rejet (AMOUNT_MISMATCH), Payment reste PENDING', async () => {
    const { handler, provider, paymentRepository, payment } = await buildScenario();
    const webhook = provider.buildWebhook({
      providerTransactionId: 'tx-1',
      outcome: 'SUCCEEDED',
      occurredAt: new Date('2026-09-01T00:05:00Z'),
      amount: Money.fromXOF(35_001).getValue(),
    });

    const result = await handler.execute({ rawBody: webhook.rawBody, signatureHeader: webhook.signatureHeader });

    expect(mustFail(result)).toBe('AMOUNT_MISMATCH');
    const stored = await paymentRepository.findById(payment.id, TENANT);
    expect(stored?.status).toBe('PENDING');
  });
});
