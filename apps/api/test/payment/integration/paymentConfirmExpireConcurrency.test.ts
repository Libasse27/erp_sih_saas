import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { Money } from '../../../src/shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Payment } from '../../../src/modules/payment/domain/Payment.js';
import { PlatformInvoice } from '../../../src/modules/payment/domain/PlatformInvoice.js';
import { ConfirmPaymentHandler } from '../../../src/modules/payment/application/commands/ConfirmPayment.js';
import { PrismaPaymentRepository } from '../../../src/modules/payment/infrastructure/persistence/PrismaPaymentRepository.js';
import { PrismaPlatformInvoiceRepository } from '../../../src/modules/payment/infrastructure/persistence/PrismaPlatformInvoiceRepository.js';
import { InMemoryPaymentProvider, mustSucceed } from '../../../test/payment/builders/testKit.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Adversarial : reproduit EXACTEMENT la race decrite dans `ReconcilePendingPayments.ts`/
 * `PrismaPaymentRepository.ts` entre le webhook de confirmation (`ConfirmPaymentHandler`) et le
 * rapprochement periodique (`ReconcilePendingPaymentsHandler`) — les DEUX peuvent lire puis
 * ecrire le MEME `Payment` PENDING concurremment. Ce test simule le second writer DIRECTEMENT
 * (`payment.markExpired()` + `paymentRepository.save()` sur une instance relue separement,
 * SANS passer par `ReconcilePendingPaymentsHandler.execute()` ni sa propre logique de retry —
 * exactement comme demande) pendant qu'un webhook SUCCEEDED valide est confirme CONCURREMMENT via
 * `ConfirmPaymentHandler.execute()` (qui, lui, beneficie de sa logique de retry sur
 * `PaymentConcurrencyConflictError`, voir ConfirmPayment.ts).
 *
 * Le statut final en base DOIT TOUJOURS etre `SUCCEEDED`/`RENEWED`, jamais ecrase par `EXPIRED`,
 * quel que soit l'ordre d'ecriture reel resolu par Postgres — c'est le verrouillage optimiste
 * (colonne `version`, migration `20260824110000_payment_optimistic_lock`) qui le garantit :
 *   - si le webhook ecrit en premier (version 0 -> 1, SUCCEEDED/RENEWED), l'ecriture EXPIRED
 *     directe (toujours a la version 0 qu'elle a lue) est REJETEE par `save()`
 *     (`PaymentConcurrencyConflictError`, non retentee ici puisque volontairement appelee SANS
 *     retry) — capturee par `Promise.allSettled` ci-dessous, jamais une exception non geree.
 *   - si l'ecriture EXPIRED directe gagne en premier (version 0 -> 1), le webhook, en perdant sa
 *     propre tentative de sauvegarde, RETENTE (voir `ConfirmPaymentHandler.saveWithConcurrencyRetry`) :
 *     il relit le Payment desormais EXPIRED (version 1), reapplique `confirmSucceeded()` (transition
 *     EXPIRED -> SUCCEEDED/RENEWED explicitement autorisee, voir Payment.ts) et re-sauvegarde
 *     (version 1 -> 2) — le succes finit TOUJOURS par l'emporter.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('Payment — race webhook SUCCEEDED vs rapprochement EXPIRED (verrouillage optimiste, adversarial)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let paymentRepository: PrismaPaymentRepository;
  let invoiceRepository: PrismaPlatformInvoiceRepository;
  let invoice: PlatformInvoice;
  let tenant: TenantId;

  const tenantId = uniqueId();
  let paymentId: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    paymentRepository = new PrismaPaymentRepository(prisma);
    invoiceRepository = new PrismaPlatformInvoiceRepository(prisma);

    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    tenant = TenantId.create(tenantId).getValue();
    const amount = Money.fromXOF(35_000).getValue();

    invoice = PlatformInvoice.issue({
      tenantId: tenant,
      subscriptionId: uniqueId(),
      planPriceId: uniqueId(),
      amount,
      periodStartsAt: new Date('2026-09-01T00:00:00Z'),
      periodEndsAt: new Date('2026-10-01T00:00:00Z'),
      clock,
      idGenerator,
    });
    await invoiceRepository.issue(invoice);
  });

  afterAll(async () => {
    if (paymentId !== undefined) {
      await rawClient.query('DELETE FROM "platform"."Payment" WHERE id = $1', [paymentId]);
    }
    await rawClient.query('DELETE FROM "platform"."PlatformInvoice" WHERE id = $1', [invoice.id.toString()]);
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('le succes du webhook n_est JAMAIS ecrase par un rapprochement EXPIRED concurrent, quel que soit l_ordre d_ecriture reel', async () => {
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const providerTransactionId = `confirm-expire-race-${uniqueId()}`;

    const initialPayment = Payment.initiate({
      tenantId: tenant,
      platformInvoiceId: invoice.id,
      subscriptionId: invoice.subscriptionId,
      purpose: 'RENEWAL',
      method: 'MOBILE_MONEY',
      amount: invoice.amount,
      providerTransactionId,
      clock,
      idGenerator,
    });
    paymentId = initialPayment.id.toString();
    await paymentRepository.save(initialPayment, tenant);

    // Instance B : simule DIRECTEMENT le rapprochement periodique (SANS passer par
    // ReconcilePendingPaymentsHandler ni sa logique de retry) — relue SEPAREMENT de ce que verra
    // ConfirmPaymentHandler en interne, exactement comme deux processus concurrents distincts le
    // feraient reellement.
    const reconciliationView = await paymentRepository.findById(initialPayment.id, tenant);
    if (reconciliationView === null) {
      throw new Error('Payment introuvable juste apres sa creation (etat de test incoherent).');
    }

    const provider = new InMemoryPaymentProvider();
    const unitOfWork = new PgUnitOfWork(prisma);
    const confirmPaymentHandler = new ConfirmPaymentHandler(
      paymentRepository,
      invoiceRepository,
      provider,
      unitOfWork,
      clock,
      idGenerator,
    );
    const webhook = provider.buildWebhook({
      providerTransactionId,
      outcome: 'SUCCEEDED',
      occurredAt: new Date(),
      amount: invoice.amount,
    });

    // Vraie concurrence : le webhook (avec sa propre logique de retry) et l'ecriture EXPIRED
    // directe (sans retry) partent EN MEME TEMPS.
    const [confirmOutcome, expireOutcome] = await Promise.allSettled([
      confirmPaymentHandler.execute({ rawBody: webhook.rawBody, signatureHeader: webhook.signatureHeader }),
      (async () => {
        reconciliationView.markExpired();
        await paymentRepository.save(reconciliationView, tenant);
      })(),
    ]);

    // Le webhook doit TOUJOURS finir par reussir (grace a sa retry) — qu'il ait gagne la course
    // du premier coup ou qu'il ait du relire/reappliquer apres une EXPIRED ecrite en premier.
    expect(confirmOutcome.status).toBe('fulfilled');
    if (confirmOutcome.status === 'fulfilled') {
      expect(mustSucceed(confirmOutcome.value).status).toBe('PROCESSED');
    }
    // L'ecriture EXPIRED directe peut echouer (course perdue, pas de retry ICI par construction du
    // test) OU reussir puis etre rattrapee par le retry du webhook — les DEUX issues sont
    // acceptables pour CETTE promesse, seul le statut final en base fait foi (assertion suivante).
    void expireOutcome;

    const finalRow = await rawClient.query('SELECT status FROM "platform"."Payment" WHERE id = $1', [paymentId]);
    const finalStatus = (finalRow.rows[0] as { status: string }).status;
    expect(['SUCCEEDED', 'RENEWED']).toContain(finalStatus);
    expect(finalStatus).not.toBe('EXPIRED');
  });
});
