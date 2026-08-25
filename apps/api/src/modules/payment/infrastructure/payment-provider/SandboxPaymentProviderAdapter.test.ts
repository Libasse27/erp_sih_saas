import { describe, expect, it } from 'vitest';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { SandboxPaymentProviderAdapter } from './SandboxPaymentProviderAdapter.js';

const SECRET = 'test-only-sandbox-webhook-secret-32-chars-min';

describe('SandboxPaymentProviderAdapter — ACL / signature HMAC (O-25.3/O-25.5)', () => {
  it('initiatePayment() renvoie un providerTransactionId unique, PENDING au demarrage', async () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    const result = await adapter.initiatePayment({
      tenantId: 'tenant-1',
      idempotencyKey: 'key-1',
      amount: Money.fromXOF(35_000).getValue(),
      method: 'MOBILE_MONEY',
    });
    expect(result.providerTransactionId).toMatch(/^sandbox_/);
    expect(await adapter.reconcileTransaction(result.providerTransactionId)).toBe('PENDING');
  });

  it('un webhook SIGNE par buildSignedWebhookPayload() est accepte par verifyWebhookSignature()', () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    const webhook = adapter.buildSignedWebhookPayload({
      providerTransactionId: 'sandbox_abc',
      outcome: 'SUCCEEDED',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
      amount: Money.fromXOF(35_000).getValue(),
    });

    expect(adapter.verifyWebhookSignature({ rawBody: webhook.rawBody, signatureHeader: webhook.signatureHeader })).toBe(true);
  });

  it('verifyWebhookSignature() rejette une signature ABSENTE', () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    expect(adapter.verifyWebhookSignature({ rawBody: '{}', signatureHeader: undefined })).toBe(false);
  });

  it('verifyWebhookSignature() rejette une signature INVALIDE (corps modifie apres signature — falsification)', () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    const webhook = adapter.buildSignedWebhookPayload({
      providerTransactionId: 'sandbox_abc',
      outcome: 'SUCCEEDED',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
      amount: Money.fromXOF(35_000).getValue(),
    });
    const tamperedBody = webhook.rawBody.replace('payment.succeeded', 'payment.failed');

    expect(adapter.verifyWebhookSignature({ rawBody: tamperedBody, signatureHeader: webhook.signatureHeader })).toBe(false);
  });

  it('verifyWebhookSignature() rejette une signature emise avec un AUTRE secret', () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    const otherAdapter = new SandboxPaymentProviderAdapter('un-autre-secret-completement-different-32c');
    const webhook = otherAdapter.buildSignedWebhookPayload({
      providerTransactionId: 'sandbox_abc',
      outcome: 'SUCCEEDED',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
      amount: Money.fromXOF(35_000).getValue(),
    });

    expect(adapter.verifyWebhookSignature({ rawBody: webhook.rawBody, signatureHeader: webhook.signatureHeader })).toBe(false);
  });

  it('parseWebhookPayload() traduit le format PROPRE AU SANDBOX vers le contrat neutre ProviderWebhookEvent', () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    const webhook = adapter.buildSignedWebhookPayload({
      providerTransactionId: 'sandbox_abc',
      outcome: 'SUCCEEDED',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
      amount: Money.fromXOF(35_000).getValue(),
    });

    const event = adapter.parseWebhookPayload(webhook.rawBody);

    expect(event).not.toBeNull();
    expect(event?.providerTransactionId).toBe('sandbox_abc');
    expect(event?.outcome).toBe('SUCCEEDED');
    expect(event?.occurredAt).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(event?.amount.amount).toBe(35_000);
  });

  it('parseWebhookPayload() renvoie null pour un JSON malforme', () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    expect(adapter.parseWebhookPayload('{ceci n est pas du json')).toBeNull();
  });

  it('parseWebhookPayload() renvoie null pour un evenement inconnu', () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    expect(
      adapter.parseWebhookPayload(JSON.stringify({ transactionId: 'x', event: 'payment.refunded', occurredAt: new Date().toISOString() })),
    ).toBeNull();
  });

  it('parseWebhookPayload() renvoie null pour une devise differente de XOF (Money est mono-devise, payload illisible pour cette ACL)', () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    expect(
      adapter.parseWebhookPayload(
        JSON.stringify({
          transactionId: 'sandbox_abc',
          event: 'payment.succeeded',
          occurredAt: new Date().toISOString(),
          amount: 35_000,
          currency: 'EUR',
        }),
      ),
    ).toBeNull();
  });

  it('reconcileTransaction() renvoie NOT_FOUND pour un providerTransactionId jamais initie', async () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    expect(await adapter.reconcileTransaction('sandbox_jamais-vu')).toBe('NOT_FOUND');
  });

  it('reconcileTransaction() reflete l_issue connue apres un webhook traite (rapprochement periodique, O-25.5)', async () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    const initiation = await adapter.initiatePayment({
      tenantId: 'tenant-1',
      idempotencyKey: 'key-1',
      amount: Money.fromXOF(35_000).getValue(),
      method: 'CARD',
    });
    const webhook = adapter.buildSignedWebhookPayload({
      providerTransactionId: initiation.providerTransactionId,
      outcome: 'SUCCEEDED',
      occurredAt: new Date(),
      amount: Money.fromXOF(35_000).getValue(),
    });
    adapter.parseWebhookPayload(webhook.rawBody);

    expect(await adapter.reconcileTransaction(initiation.providerTransactionId)).toBe('SUCCEEDED');
  });

  it('simulateProviderOutcome() permet de simuler un rapprochement SANS webhook (absence totale de notification)', async () => {
    const adapter = new SandboxPaymentProviderAdapter(SECRET);
    const initiation = await adapter.initiatePayment({
      tenantId: 'tenant-1',
      idempotencyKey: 'key-1',
      amount: Money.fromXOF(35_000).getValue(),
      method: 'CARD',
    });

    adapter.simulateProviderOutcome(initiation.providerTransactionId, 'SUCCEEDED');

    expect(await adapter.reconcileTransaction(initiation.providerTransactionId)).toBe('SUCCEEDED');
  });
});
