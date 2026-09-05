import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { SandboxPaymentProviderAdapter } from '../../../src/modules/payment/infrastructure/payment-provider/SandboxPaymentProviderAdapter.js';
import { Money } from '../../../src/shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Payment } from '../../../src/modules/payment/domain/Payment.js';
import { PlatformInvoice } from '../../../src/modules/payment/domain/PlatformInvoice.js';
import { postRaw, startTestServer, type TestServerHandle } from '../../server/httpTestClient.js';
import { createRawPgClient, uniqueId } from './dbTestHelpers.js';

const GLOBAL_WEBHOOK_RATE_LIMIT_KEY = 'sih:rate-limit:payment-webhook:global';

/**
 * `ioredis` expose `eval` avec de nombreuses surcharges (script/callback/tableau de cles...) —
 * inexploitable tel quel avec `vi.spyOn(...).mockRejectedValueOnce(...)`. Cette interface REDUIT
 * la signature a l'UNIQUE forme reellement appelee par `RedisRateLimiter.consume` (voir
 * `RedisRateLimiter.ts` : `eval(script, 1, key, windowSeconds)`), sans jamais recourir a `any` —
 * la meme instance `root.redis` (identite d'objet preservee par le cast) est bien celle dont la
 * methode `eval` est remplacee.
 */
interface EvalCapableRedisClient {
  eval(script: string, numkeys: number, key: string, windowSeconds: string): Promise<unknown>;
}

function asEvalCapable(redis: CompositionRoot['redis']): EvalCapableRedisClient {
  return redis as unknown as EvalCapableRedisClient;
}

/**
 * Test de non-regression EXIGE par ADR-0011, Amendement 1 (2026-09-05), BLOQUANT-1.
 *
 * Constat ferme par l'amendement : `SilentRateLimitGuard.ts` livre laissait echapper toute
 * exception de `limiter.consume(...)` vers `.catch(next)` -> `createErrorHandler` -> `500`, alors
 * que le Gate exige que le webhook ne reponde JAMAIS autre chose que `200` (corps vide),
 * INDISTINGUABLE de tous les autres cas de cette route, MEME quand le limiteur lui-meme est en
 * panne (Redis en bascule, timeout, OOM, erreur `EVAL`) — pas seulement quand le seuil est
 * legitimement depasse.
 *
 * Ce fichier fait echouer REELLEMENT `RedisRateLimiter.consume(...)` (double du `RateLimiter`,
 * au sens strict de l'amendement : on force la promesse de `consume` a rejeter) en interceptant
 * l'UNIQUE commande Redis qu'il execute (`eval`, le script Lua atomique — voir
 * `RedisRateLimiter.ts`), PLUTOT que de couper la connexion Redis elle-meme (ce qui affecterait
 * aussi les sessions/le cache partageant la MEME connexion et rendrait le test instable). Le
 * cablage traverse est le VRAI : `buildCompositionRoot()` + `createApp(root)`, la VRAIE route
 * `POST /api/v1/payments/webhook`, le VRAI callback `onRejected` de `composition-root.ts` (qui
 * traduit le motif du guard en motif de LOG applicatif) — jamais un Express minimal reconstruit a
 * la main.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('POST /api/v1/payments/webhook — fail-closed silencieux quand le limiteur lui-meme est en panne (ADR-0011 Amendement 1, BLOQUANT-1)', () => {
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

  /** Plante un couple `PlatformInvoice`/`Payment` (statut initial PENDING) reel en base — meme Test Data Builder que `paymentWebhookHttp.test.ts`/`paymentWebhookRateLimiting.test.ts`. */
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

    const providerTransactionId = `webhook-rate-limiter-failure-${uniqueId()}`;
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

  it(
    'limiter.consume() qui rejette sa promesse -> 200 EXACTEMENT, corps vide, ET le traitement metier n_a PAS lieu (fail-closed, pas fail-open)',
    async () => {
      // Interception de l'UNIQUE commande Redis executee par `RedisRateLimiter.consume` (le script
      // Lua atomique via `eval`) : `consume(...)` rejette donc reellement sa promesse, exactement
      // comme le prescrit l'amendement, sans toucher a la connexion Redis partagee par le reste du
      // processus (sessions, cache).
      const evalSpy = vi.spyOn(asEvalCapable(root.redis), 'eval').mockRejectedValueOnce(new Error('ECONNRESET simulee (double de test, BLOQUANT-1)'));
      try {
        const { payment, providerTransactionId } = await plantPendingPayment();
        const { rawBody, signatureHeader } = sandbox.buildSignedWebhookPayload({
          providerTransactionId,
          outcome: 'SUCCEEDED',
          occurredAt: root.clock.now(),
          amount: payment.amount,
        });

        const response = await postRaw(handle.baseUrl, '/api/v1/payments/webhook', rawBody, {
          headers: { 'x-payment-signature': signatureHeader },
        });

        // L'invariant du Gate (D4) : `200`, corps vide, JAMAIS `500` -- meme quand le limiteur
        // lui-meme echoue, pas seulement quand le seuil est legitimement depasse.
        expect(response.status).toBe(200);
        expect(response.body).toBe('');

        // Fail-CLOSED, pas fail-open (decision explicite de l'amendement) : la requete est traitee
        // COMME un depassement de seuil -- aucune verification de signature, aucun acces base,
        // aucun traitement metier n'a eu lieu au-dela du guard. Preuve directe : le `Payment`
        // pourtant valide et correctement signe reste `PENDING`, jamais `SUCCEEDED`.
        expect(await paymentStatus(payment.id.toString())).toBe('PENDING');

        expect(evalSpy).toHaveBeenCalledTimes(1);
      } finally {
        evalSpy.mockRestore();
      }
    },
    20_000,
  );

  it(
    'aucune AuditEntry produite quand le limiteur est en panne : le tenant plante par ce scenario (identifiant aleatoire, jamais reference ailleurs) reste TOTALEMENT vide apres la requete',
    async () => {
      // Meme discipline que `paymentWebhookRateLimiting.test.ts` ("aucune AuditEntry produite par
      // un rejet de debit") : un `count()` GLOBAL sur `AuditEntry` serait INFIABLE (base PARTAGEE
      // par de nombreux fichiers de test paralleles). Le perimetre d'un tenant flambant neuf,
      // reference NULLE PART ailleurs, est en revanche un temoin fiable. Garantie STRUCTURELLE
      // rappelee par l'amendement : `SilentRateLimitGuard.ts` n'importe ni Prisma ni le module
      // `audit` (verifie par lecture de code, `rateLimitArchitecture.test.ts`) -- aucune
      // `AuditEntry` ne peut donc structurellement etre ecrite par ce chemin, quel que soit le
      // tenant.
      const evalSpy = vi.spyOn(asEvalCapable(root.redis), 'eval').mockRejectedValueOnce(new Error('ECONNRESET simulee (double de test, BLOQUANT-1)'));
      try {
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

        const page = await root.audit.repositories.auditEntries.listForTenant(tenantId, {}, { cursor: null, limit: 200 });
        expect(page.entries).toHaveLength(0);
      } finally {
        evalSpy.mockRestore();
      }
    },
    20_000,
  );

  it(
    'un log { event: "payment.webhook.rejected", reason: "rate_limiter_unavailable" } est emis -- JAMAIS "rate_limited", qui mentirait sur la cause reelle',
    async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const evalSpy = vi.spyOn(asEvalCapable(root.redis), 'eval').mockRejectedValueOnce(new Error('ECONNRESET simulee (double de test, BLOQUANT-1)'));
      try {
        const { payment, providerTransactionId } = await plantPendingPayment();
        const { rawBody, signatureHeader } = sandbox.buildSignedWebhookPayload({
          providerTransactionId,
          outcome: 'SUCCEEDED',
          occurredAt: root.clock.now(),
          amount: payment.amount,
        });

        await postRaw(handle.baseUrl, '/api/v1/payments/webhook', rawBody, {
          headers: { 'x-payment-signature': signatureHeader },
        });

        const parsedLogs = warnSpy.mock.calls
          .map((call) => String(call[0]))
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((entry) => entry.event === 'payment.webhook.rejected');

        const unavailableLogs = parsedLogs.filter((entry) => entry.reason === 'rate_limiter_unavailable');
        const misattributedLogs = parsedLogs.filter((entry) => entry.reason === 'rate_limited');

        expect(unavailableLogs).toHaveLength(1);
        expect(misattributedLogs).toHaveLength(0);
        for (const line of warnSpy.mock.calls.map((call) => String(call[0]))) {
          expect(line).not.toContain(rawBody);
          expect(line).not.toContain(signatureHeader);
        }
      } finally {
        evalSpy.mockRestore();
        warnSpy.mockRestore();
      }
    },
    20_000,
  );

  it(`la cle ${GLOBAL_WEBHOOK_RATE_LIMIT_KEY} n_est PAS posee quand le script Lua echoue (aucune commande Redis reussie, rien a incrementer)`, async () => {
    await root.redis.del(GLOBAL_WEBHOOK_RATE_LIMIT_KEY);
    const evalSpy = vi.spyOn(asEvalCapable(root.redis), 'eval').mockRejectedValueOnce(new Error('ECONNRESET simulee (double de test, BLOQUANT-1)'));
    try {
      const response = await postRaw(handle.baseUrl, '/api/v1/payments/webhook', 'garbage-body-not-a-valid-payload');
      expect(response.status).toBe(200);
      const exists = await root.redis.exists(GLOBAL_WEBHOOK_RATE_LIMIT_KEY);
      expect(exists).toBe(0);
    } finally {
      evalSpy.mockRestore();
      await root.redis.del(GLOBAL_WEBHOOK_RATE_LIMIT_KEY);
    }
  });
});
