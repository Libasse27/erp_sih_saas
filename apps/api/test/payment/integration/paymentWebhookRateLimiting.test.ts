import type { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { SandboxPaymentProviderAdapter } from '../../../src/modules/payment/infrastructure/payment-provider/SandboxPaymentProviderAdapter.js';
import { Money } from '../../../src/shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Payment } from '../../../src/modules/payment/domain/Payment.js';
import { PlatformInvoice } from '../../../src/modules/payment/domain/PlatformInvoice.js';
import { PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS } from '../../../src/shared-kernel/domain/RateLimitTuning.js';
import { postRaw, startTestServer, type TestServerHandle } from '../../server/httpTestClient.js';
import { createRawPgClient, uniqueId } from './dbTestHelpers.js';

const GLOBAL_WEBHOOK_RATE_LIMIT_KEY = 'sih:rate-limit:payment-webhook:global';

/**
 * Limitation de debit GLOBALE de `POST /api/v1/payments/webhook` (ADR-0011 §3/§5, decision D2/D4)
 * — mecanisme REEL contre Redis REEL. Aucune assertion de ce fichier ne porte sur le code de
 * statut HTTP pour distinguer un cas d'un autre (meme discipline que
 * `test/payment/integration/paymentWebhookHttp.test.ts`, dont l'en-tete l'enonce explicitement) :
 * la route repond `200` DANS TOUS LES CAS, y compris rejetee par la limitation de debit — les
 * assertions portent sur l'ETAT REEL en base (`Payment.status`, compte d'`AuditEntry`).
 *
 * Isolation du test de flood (ADR-0011, "Tests attendus", residu 6) : le compteur cle est
 * `sih:rate-limit:payment-webhook:global`, PARTAGE par TOUT LE PROCESSUS ET par tout fichier de
 * test execute en parallele sur le MEME Redis (ce fichier n'est jamais le seul a appeler cette
 * route — voir `paymentWebhookHttp.test.ts`). La cle est donc supprimee explicitement AVANT et
 * APRES chaque scenario qui la sature, jamais en relevant le seuil de `RateLimitTuning.ts` pour
 * faire passer la suite.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('POST /api/v1/payments/webhook — limitation de debit GLOBALE (ADR-0011 §3/§5)', () => {
  let root: CompositionRoot;
  let handle: TestServerHandle;
  let rawClient: Client;
  let sandbox: SandboxPaymentProviderAdapter;

  const createdPaymentIds: string[] = [];
  const createdInvoiceIds: string[] = [];

  beforeAll(async () => {
    root = buildCompositionRoot();
    const app = createApp(root);
    handle = await startTestServer(app);
    rawClient = await createRawPgClient();
    sandbox = new SandboxPaymentProviderAdapter(root.env.PAYMENT_PROVIDER_WEBHOOK_SECRET);
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

  beforeEach(async () => {
    await root.redis.del(GLOBAL_WEBHOOK_RATE_LIMIT_KEY);
  });

  afterEach(async () => {
    await root.redis.del(GLOBAL_WEBHOOK_RATE_LIMIT_KEY);
  });

  /** Plante un couple `PlatformInvoice`/`Payment` (statut initial PENDING) reel en base — meme Test Data Builder que `paymentWebhookHttp.test.ts`. */
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

    const providerTransactionId = `webhook-rate-limit-${uniqueId()}`;
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

  /** `3 x MAX` corps illisibles (jamais signes) : chacun coute une consommation du compteur GLOBAL, jamais un acces base couteux au-dela du seuil. */
  async function floodWithGarbage(count: number, localAddress?: string): Promise<readonly { status: number; body: string }[]> {
    const responses = [];
    for (let i = 0; i < count; i += 1) {
      responses.push(
        await postRaw(handle.baseUrl, '/api/v1/payments/webhook', `garbage-${i}-not-a-valid-payload`, localAddress === undefined ? {} : { localAddress }),
      );
    }
    return responses;
  }

  it(
    `jamais 429 : 3 x ${PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS} requetes consecutives -> l_ensemble des statuts observes est EXACTEMENT {200}, corps vide dans tous les cas`,
    async () => {
      const responses = await floodWithGarbage(PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS * 3);
      const statuses = new Set(responses.map((r) => r.status));
      expect(statuses).toEqual(new Set([200]));
      for (const response of responses) {
        expect(response.body).toBe('');
      }
    },
    30_000,
  );

  it(
    'rejet silencieux REELLEMENT silencieux : apres epuisement du compteur, un webhook VALIDE et signe visant un Payment PENDING -> 200, mais le Payment reste PENDING et AUCUNE entree BILLING_PAYMENT_CONFIRMED n_est ecrite (preuve que le traitement metier n_a pas eu lieu)',
    async () => {
      await floodWithGarbage(PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS);

      const { tenantId, payment, providerTransactionId } = await plantPendingPayment();
      const { rawBody, signatureHeader } = sandbox.buildSignedWebhookPayload({
        providerTransactionId,
        outcome: 'SUCCEEDED',
        occurredAt: root.clock.now(),
        amount: payment.amount,
      });

      const response = await postRaw(handle.baseUrl, '/api/v1/payments/webhook', rawBody, {
        headers: { 'x-payment-signature': signatureHeader },
      });

      expect(response.status).toBe(200);
      expect(response.body).toBe('');
      expect(await paymentStatus(payment.id.toString())).toBe('PENDING');
      expect(await countBillingPaymentConfirmedEntries(tenantId)).toBe(0);
    },
    20_000,
  );

  it(
    'preuve directe D2 — compteur GLOBAL : compteur epuise depuis l_adresse source A, un webhook VALIDE emis depuis l_adresse source B (tenant DIFFERENT) est EGALEMENT ignore (une cle par IP le ferait passer)',
    async () => {
      await floodWithGarbage(PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS, '127.10.10.10');

      const { tenantId, payment, providerTransactionId } = await plantPendingPayment();
      const { rawBody, signatureHeader } = sandbox.buildSignedWebhookPayload({
        providerTransactionId,
        outcome: 'SUCCEEDED',
        occurredAt: root.clock.now(),
        amount: payment.amount,
      });

      const response = await postRaw(handle.baseUrl, '/api/v1/payments/webhook', rawBody, {
        headers: { 'x-payment-signature': signatureHeader },
        localAddress: '127.20.20.20',
      });

      expect(response.status).toBe(200);
      expect(await paymentStatus(payment.id.toString())).toBe('PENDING');
      expect(await countBillingPaymentConfirmedEntries(tenantId)).toBe(0);
    },
    20_000,
  );

  it(
    'aucune cle par tenant : deux webhooks VALIDES concernant deux tenants DISTINCTS, envoyes apres epuisement du compteur, consomment le MEME compteur (les deux sont ignores)',
    async () => {
      await floodWithGarbage(PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS);

      const first = await plantPendingPayment();
      const second = await plantPendingPayment();
      expect(first.tenantId.toString()).not.toBe(second.tenantId.toString());

      for (const { tenantId, payment, providerTransactionId } of [first, second]) {
        const { rawBody, signatureHeader } = sandbox.buildSignedWebhookPayload({
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
      }
    },
    20_000,
  );

  it(
    'aucune AuditEntry produite par un rejet de debit : le tenant plante par ce scenario (identifiant aleatoire, jamais reference ailleurs) reste TOTALEMENT vide apres la rafale',
    async () => {
      // Un `count()` GLOBAL sur `AuditEntry` (comme le fait `rateLimiting.test.ts` pour les cinq
      // routes ADR-0010) est INFIABLE ici : cette base est PARTAGEE par de nombreux autres
      // fichiers de test qui ecrivent des `AuditEntry` en continu, potentiellement en parallele
      // (tenants/sessions/MFA...) — un delta non nul y refleterait TOUJOURS un fichier VOISIN,
      // jamais une regression de ce guard. Le perimetre d'un tenant flambant neuf, cree ICI et
      // reference NULLE PART ailleurs, est en revanche un temoin fiable : AUCUN autre test ne peut
      // y ecrire quoi que ce soit.
      const { tenantId } = await plantPendingPayment();
      await floodWithGarbage(PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS + 10);
      const page = await root.audit.repositories.auditEntries.listForTenant(tenantId, {}, { cursor: null, limit: 200 });
      expect(page.entries).toHaveLength(0);
    },
    20_000,
  );

  it(
    'un log { event: "payment.webhook.rejected", reason: "rate_limited" } est emis sur rejet, sans corps brut, sans en-tete x-payment-signature, sans IP',
    async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await floodWithGarbage(PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS);
        const secretSignature = 'sha256=' + 'f'.repeat(64);
        const rawBody = 'un-corps-jamais-journalise';
        await postRaw(handle.baseUrl, '/api/v1/payments/webhook', rawBody, {
          headers: { 'x-payment-signature': secretSignature },
          localAddress: '127.30.30.30',
        });

        // `event: 'payment.webhook.rejected'` est REUTILISE tel quel (ADR-0011 §5.3, Gate
        // d'implementation, verbatim) par PLUSIEURS causes de rejet DEJA existantes dans
        // `ConfirmPayment.ts` (`invalid_signature`, `invalid_payload`, `unknown_transaction`,
        // `amount_mismatch`) — seul le champ `reason` discrimine celle du guard de limitation de
        // debit (`rate_limited`). Filtrer sur ce SEUL champ, jamais sur la seule presence de
        // l'evenement dans la ligne.
        const rateLimitedLogs = warnSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            return parsed.event === 'payment.webhook.rejected' && parsed.reason === 'rate_limited';
          });
        expect(rateLimitedLogs).toHaveLength(1);
        for (const line of rateLimitedLogs) {
          expect(line).not.toContain(rawBody);
          expect(line).not.toContain(secretSignature);
          expect(line).not.toContain('127.30.30.30');
        }
      } finally {
        warnSpy.mockRestore();
      }
    },
    20_000,
  );

  it(
    `la cle ${GLOBAL_WEBHOOK_RATE_LIMIT_KEY} a un TTL > 0 apres la rafale`,
    async () => {
      await floodWithGarbage(PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS + 2);
      const ttl = await root.redis.ttl(GLOBAL_WEBHOOK_RATE_LIMIT_KEY);
      expect(ttl).toBeGreaterThan(0);
    },
    20_000,
  );
});
