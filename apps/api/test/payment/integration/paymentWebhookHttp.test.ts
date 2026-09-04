import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { SandboxPaymentProviderAdapter } from '../../../src/modules/payment/infrastructure/payment-provider/SandboxPaymentProviderAdapter.js';
import { Money } from '../../../src/shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Payment } from '../../../src/modules/payment/domain/Payment.js';
import { PlatformInvoice } from '../../../src/modules/payment/domain/PlatformInvoice.js';
import { postRaw, postJson, startTestServer, type TestServerHandle } from '../../server/httpTestClient.js';
import { createRawPgClient, uniqueId } from './dbTestHelpers.js';

/**
 * Cablage HTTP REEL du webhook paiement (O-25.5, etape 12/13 du sweep de securite) — la logique
 * metier (signature invalide/absente, payload illisible, rejeu idempotent, montant incoherent)
 * est DEJA testee exhaustivement au niveau HANDLER dans
 * `src/modules/payment/application/commands/ConfirmPayment.test.ts` (13 cas, port `PaymentProvider`
 * en memoire) — ce fichier ne duplique AUCUN de ces cas. Le gap couvert ICI est le CABLAGE : la
 * VRAIE route Express (`express.raw({ type: '*'/'*' , limit: '256kb' })`, PAS `express.json()` —
 * le corps brut compte pour la signature HMAC, voir server.ts), le VRAI en-tete
 * `x-payment-signature`, et le VRAI `SandboxPaymentProviderAdapter` (cle secrete reelle
 * `env.PAYMENT_PROVIDER_WEBHOOK_SECRET`, cablee par `buildCompositionRoot()`) fonctionnent bout en
 * bout.
 *
 * `PaymentWebhookController.handle` repond TOUJOURS 200, quelle que soit l'issue (voir son
 * commentaire de tete : non-fuite d'information) — AUCUNE assertion de ce fichier ne porte donc
 * sur le code de statut HTTP pour distinguer un cas d'un autre. Les assertions portent
 * exclusivement sur l'etat REEL en base (`Payment.status`) et sur l'audit trail
 * (`BILLING_PAYMENT_CONFIRMED`, categorie `BILLING`, ecrit par `AuditModuleBackedBillingAuditTrail`
 * cote `composition-root.ts`).
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('POST /api/v1/payments/webhook — cablage HTTP reel (O-25.5)', () => {
  let root: CompositionRoot;
  let handle: TestServerHandle;
  let rawClient: Client;
  let sandbox: SandboxPaymentProviderAdapter;
  let wrongSecretSandbox: SandboxPaymentProviderAdapter;

  const createdPaymentIds: string[] = [];
  const createdInvoiceIds: string[] = [];

  beforeAll(async () => {
    root = buildCompositionRoot();
    const app = createApp(root);
    handle = await startTestServer(app);
    rawClient = await createRawPgClient();

    // MEME secret que celui reellement cable par `buildCompositionRoot()` (voir
    // `env.PAYMENT_PROVIDER_WEBHOOK_SECRET`) : cette instance sert UNIQUEMENT a SIGNER des
    // payloads de test (`buildSignedWebhookPayload`, outil sandbox prevu a cet effet, jamais une
    // methode du port `PaymentProvider`) — la VERIFICATION de signature, elle, est faite par le
    // VRAI adaptateur du serveur (`root.payment`), instance SEPAREE.
    sandbox = new SandboxPaymentProviderAdapter(root.env.PAYMENT_PROVIDER_WEBHOOK_SECRET);
    // Secret DIFFERENT (mais toujours >= 32 caracteres, meme contrainte que le vrai `env.ts`) :
    // produit une signature structurellement valide (`sha256=<64 hex>`) mais dont la VALEUR ne
    // correspond jamais a celle attendue par le vrai secret du serveur — scenario "signature
    // invalide" realiste (mauvais secret), pas juste une chaine arbitraire.
    wrongSecretSandbox = new SandboxPaymentProviderAdapter('z'.repeat(40));
  });

  afterAll(async () => {
    for (const paymentId of createdPaymentIds) {
      await rawClient.query('DELETE FROM "platform"."Payment" WHERE id = $1', [paymentId]);
    }
    for (const invoiceId of createdInvoiceIds) {
      await rawClient.query('DELETE FROM "platform"."PlatformInvoice" WHERE id = $1', [invoiceId]);
    }
    await rawClient.end();
    await handle.close();
    await root.shutdown();
  });

  /** Plante un couple `PlatformInvoice`/`Payment` (statut initial PENDING) reel en base, via les REPOSITORIES du VRAI `CompositionRoot` — jamais une double du domaine. */
  async function plantPendingPayment(): Promise<{ tenantId: TenantId; payment: Payment; providerTransactionId: string }> {
    const tenant = TenantId.create(uniqueId()).getValue();
    const amount = Money.fromXOF(12_000).getValue();

    const invoice = PlatformInvoice.issue({
      tenantId: tenant,
      subscriptionId: uniqueId(),
      planPriceId: uniqueId(),
      purpose: 'RENEWAL',
      amount,
      periodStartsAt: new Date('2026-09-01T00:00:00Z'),
      periodEndsAt: new Date('2026-10-01T00:00:00Z'),
      clock: root.clock,
      idGenerator: root.idGenerator,
    });
    await root.payment.repositories.platformInvoices.issue(invoice);
    createdInvoiceIds.push(invoice.id.toString());

    const providerTransactionId = `webhook-http-${uniqueId()}`;
    const payment = Payment.initiate({
      tenantId: tenant,
      platformInvoiceId: invoice.id,
      subscriptionId: invoice.subscriptionId,
      purpose: 'INITIAL',
      method: 'MOBILE_MONEY',
      amount,
      providerTransactionId,
      clock: root.clock,
      idGenerator: root.idGenerator,
    });
    await root.payment.repositories.payments.save(payment, tenant);
    createdPaymentIds.push(payment.id.toString());

    return { tenantId: tenant, payment, providerTransactionId };
  }

  async function paymentStatus(paymentId: string): Promise<string> {
    const row = await rawClient.query<{ status: string }>('SELECT status FROM "platform"."Payment" WHERE id = $1', [paymentId]);
    const status = row.rows[0]?.status;
    if (status === undefined) {
      throw new Error(`Payment ${paymentId} introuvable en base (etat de test incoherent).`);
    }
    return status;
  }

  async function countBillingPaymentConfirmedEntries(tenantId: TenantId): Promise<number> {
    const page = await root.audit.repositories.auditEntries.listForTenant(
      tenantId,
      { categories: ['BILLING'], eventTypes: ['BILLING_PAYMENT_CONFIRMED'] },
      { cursor: null, limit: 200 },
    );
    return page.entries.length;
  }

  it(
    'webhook SANS en-tete x-payment-signature -> 200 (non-fuite d_info), mais le Payment reste ' +
      'PENDING en base et AUCUNE entree BILLING_PAYMENT_CONFIRMED n_est ecrite',
    async () => {
      const { tenantId, payment, providerTransactionId } = await plantPendingPayment();
      const { rawBody } = sandbox.buildSignedWebhookPayload({
        providerTransactionId,
        outcome: 'SUCCEEDED',
        occurredAt: root.clock.now(),
        amount: payment.amount,
      });

      const response = await postRaw(handle.baseUrl, '/api/v1/payments/webhook', rawBody);

      expect(response.status).toBe(200);
      expect(await paymentStatus(payment.id.toString())).toBe('PENDING');
      expect(await countBillingPaymentConfirmedEntries(tenantId)).toBe(0);
    },
  );

  it(
    'webhook avec une signature INVALIDE (mauvais secret) -> 200, mais le Payment reste PENDING ' +
      'en base et AUCUNE entree BILLING_PAYMENT_CONFIRMED n_est ecrite',
    async () => {
      const { tenantId, payment, providerTransactionId } = await plantPendingPayment();
      const { rawBody, signatureHeader } = wrongSecretSandbox.buildSignedWebhookPayload({
        providerTransactionId,
        outcome: 'SUCCEEDED',
        occurredAt: root.clock.now(),
        amount: payment.amount,
      });

      const response = await postRaw(handle.baseUrl, '/api/v1/payments/webhook', rawBody, {
        headers: { 'x-payment-signature': signatureHeader },
      });

      expect(response.status).toBe(200);
      expect(await paymentStatus(payment.id.toString())).toBe('PENDING');
      expect(await countBillingPaymentConfirmedEntries(tenantId)).toBe(0);
    },
  );

  it(
    'webhook VALIDE envoye DEUX FOIS (rejeu HTTP reel) -> 200 les deux fois, Payment confirme ' +
      '(SUCCEEDED) apres le PREMIER, UN SEUL effet (une seule entree BILLING_PAYMENT_CONFIRMED, ' +
      'jamais deux) apres le second — preuve d_idempotence au niveau HTTP, pas juste au niveau handler',
    async () => {
      const { tenantId, payment, providerTransactionId } = await plantPendingPayment();
      const { rawBody, signatureHeader } = sandbox.buildSignedWebhookPayload({
        providerTransactionId,
        outcome: 'SUCCEEDED',
        occurredAt: root.clock.now(),
        amount: payment.amount,
      });

      const first = await postRaw(handle.baseUrl, '/api/v1/payments/webhook', rawBody, {
        headers: { 'x-payment-signature': signatureHeader },
      });
      expect(first.status).toBe(200);
      expect(await paymentStatus(payment.id.toString())).toBe('SUCCEEDED');
      expect(await countBillingPaymentConfirmedEntries(tenantId)).toBe(1);

      // Rejeu EXACT (memes octets, meme signature) via une SECONDE requete HTTP independante —
      // jamais un second appel direct au handler.
      const second = await postRaw(handle.baseUrl, '/api/v1/payments/webhook', rawBody, {
        headers: { 'x-payment-signature': signatureHeader },
      });
      expect(second.status).toBe(200);
      expect(await paymentStatus(payment.id.toString())).toBe('SUCCEEDED');
      expect(await countBillingPaymentConfirmedEntries(tenantId)).toBe(1);
    },
  );

  it(
    'controle de forme (sanity check du montage express.raw) : un corps JSON envoye via postJson ' +
      '(Content-Type application/json, comme le ferait un client HTTP standard) est bien lu comme ' +
      'corps BRUT par la route (jamais desserialise par express.json(), absent de cette route) — ' +
      'signature valide EXIGEE malgre un Content-Type JSON explicite',
    async () => {
      const { tenantId, payment, providerTransactionId } = await plantPendingPayment();
      const payload = {
        transactionId: providerTransactionId,
        event: 'payment.succeeded',
        occurredAt: root.clock.now().toISOString(),
        amount: payment.amount.amount,
        currency: payment.amount.currency,
      };

      // `postJson` envoie `Content-Type: application/json` mais AUCUN `x-payment-signature` —
      // meme garantie que le premier cas (aucune fuite via une route qui accepterait un
      // Content-Type "de confiance" sans signature).
      const response = await postJson(handle.baseUrl, '/api/v1/payments/webhook', payload);

      expect(response.status).toBe(200);
      expect(await paymentStatus(payment.id.toString())).toBe('PENDING');
      expect(await countBillingPaymentConfirmedEntries(tenantId)).toBe(0);
    },
  );
});
