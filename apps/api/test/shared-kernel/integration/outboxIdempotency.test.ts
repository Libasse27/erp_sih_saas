import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { withOutboxIdempotency } from '../../../src/shared-kernel/infrastructure/persistence/OutboxIdempotencyGuard.js';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../src/shared-kernel/application/OutboxEventHandler.js';
import { Money } from '../../../src/shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { PlatformInvoice } from '../../../src/modules/payment/domain/PlatformInvoice.js';
import { PrismaPlatformInvoiceRepository } from '../../../src/modules/payment/infrastructure/persistence/PrismaPlatformInvoiceRepository.js';
import { createMarkPlatformInvoicePaidOnPaymentSucceededHandler } from '../../../src/modules/payment/application/services/MarkPlatformInvoicePaidOnPaymentSucceeded.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Adversarial — registre GENERIQUE d'idempotence consommateur (D9, etape 6/13). Postgres reel
 * (`OutboxConsumedEvent`), AUCUN mock de la couche persistance — memes conventions que
 * test/payment/integration, test/subscription/integration.
 *
 * Preuve recherchee : rejouer DEUX FOIS le meme (message Outbox, handler) n'invoque le handler
 * qu'UNE SEULE fois — teste avec DEUX categories de handlers distinctes :
 *   1. un handler FACTICE, uniquement destine a ce test, branche sur un evenement Identity
 *      REELLEMENT persiste dans l'Outbox depuis cette etape (`identity.user-account.created`,
 *      voir PrismaUserAccountRepository.ts) — AUCUN consommateur reel de cet evenement n'existe
 *      en production (voir docs/domain/events.md), ce handler ne sert qu'a faire la preuve du
 *      mecanisme generique sur un evenement desormais reellement relaye.
 *   2. le handler Payment REEL et deja existant `MarkPlatformInvoicePaidOnPaymentSucceeded` —
 *      enveloppe d'abord dans un espion (`vi.fn`) puis dans `withOutboxIdempotency` : la seconde
 *      invocation ne doit MEME PAS atteindre l'espion, preuve que c'est le REGISTRE GENERIQUE (et
 *      non la garde d'idempotence propre a `PlatformInvoice.markPaid()`, deja demontree ailleurs)
 *      qui court-circuite la re-livraison.
 */
describe('withOutboxIdempotency — registre generique, rejeu du meme (message, handler) (adversarial)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let outboxMessageIds: string[] = [];

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
  });

  afterAll(async () => {
    if (outboxMessageIds.length > 0) {
      // ON DELETE CASCADE sur OutboxConsumedEvent (voir migration) : supprimer le message suffit.
      await rawClient.query('DELETE FROM "platform"."OutboxMessage" WHERE id = ANY($1)', [outboxMessageIds]);
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  async function insertDummyOutboxMessage(params: { id: string; eventType: string; tenantId: string | null }): Promise<void> {
    outboxMessageIds.push(params.id);
    // NB : `aggregate_id` recoit une DEUXIEME occurrence explicite de `params.id` ($3), jamais
    // une reutilisation de $1 — Postgres infererait alors DEUX types differents (uuid pour la
    // colonne `id`, text pour `aggregate_id`) pour le MEME numero de parametre et rejetterait la
    // requete ("inconsistent types deduced for parameter $1").
    await rawClient.query(
      `INSERT INTO "platform"."OutboxMessage"
         (id, event_type, event_version, aggregate_id, tenant_id, payload, status, occurred_at)
       VALUES ($1, $2, 1, $3, $4, '{}'::jsonb, 'PROCESSED', now())`,
      [params.id, params.eventType, params.id, params.tenantId],
    );
  }

  async function countConsumedRows(outboxMessageId: string, handlerName: string): Promise<number> {
    const result = await rawClient.query(
      'SELECT count(*)::int AS count FROM "platform"."OutboxConsumedEvent" WHERE outbox_message_id = $1 AND handler_name = $2',
      [outboxMessageId, handlerName],
    );
    return (result.rows[0] as { count: number }).count;
  }

  it("un handler FACTICE branche sur un evenement Identity n'applique son effet qu'une seule fois, meme rejoue deux fois", async () => {
    const outboxMessageId = uniqueId();
    await insertDummyOutboxMessage({
      id: outboxMessageId,
      eventType: 'identity.user-account.created',
      tenantId: null,
    });

    let callCount = 0;
    const fakeHandler: OutboxEventHandler = async () => {
      callCount += 1;
    };
    const wrapped = withOutboxIdempotency(prisma, 'test.fake-identity-consumer', fakeHandler);

    const envelope: OutboxEventEnvelope = {
      id: outboxMessageId,
      eventType: 'identity.user-account.created',
      eventVersion: 1,
      aggregateId: outboxMessageId,
      tenantId: null,
      occurredAt: new Date(),
      payload: {},
    };

    await wrapped(envelope);
    await wrapped(envelope);

    expect(callCount).toBe(1);
    expect(await countConsumedRows(outboxMessageId, 'test.fake-identity-consumer')).toBe(1);
  });

  it("le handler Payment existant MarkPlatformInvoicePaidOnPaymentSucceeded n'est invoque qu'une seule fois pour le meme message, la seconde livraison etant court-circuitee AVANT d'atteindre le handler", async () => {
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const tenantId = TenantId.create(uniqueId()).getValue();
    const invoiceRepository = new PrismaPlatformInvoiceRepository(prisma);
    const unitOfWork = new PgUnitOfWork(prisma);

    const invoice = PlatformInvoice.issue({
      tenantId,
      subscriptionId: uniqueId(),
      planPriceId: uniqueId(),
      purpose: 'RENEWAL',
      amount: Money.fromXOF(35_000).getValue(),
      periodStartsAt: new Date('2026-09-01T00:00:00Z'),
      periodEndsAt: new Date('2026-10-01T00:00:00Z'),
      clock,
      idGenerator,
    });
    await unitOfWork.withTransaction(() => invoiceRepository.issue(invoice), { tenantId });

    const outboxMessageId = uniqueId();
    await insertDummyOutboxMessage({
      id: outboxMessageId,
      eventType: 'payment.payment.saas-payment-succeeded',
      tenantId: tenantId.toString(),
    });

    const realHandler = createMarkPlatformInvoicePaidOnPaymentSucceededHandler({
      platformInvoiceRepository: invoiceRepository,
      unitOfWork,
      clock,
    });
    const spyHandler = vi.fn(realHandler);
    const wrapped = withOutboxIdempotency(prisma, 'test.markPlatformInvoicePaidOnPaymentSucceeded', spyHandler);

    const envelope: OutboxEventEnvelope = {
      id: outboxMessageId,
      eventType: 'payment.payment.saas-payment-succeeded',
      eventVersion: 1,
      aggregateId: uniqueId(),
      tenantId: tenantId.toString(),
      occurredAt: clock.now(),
      payload: { tenantId: tenantId.toString(), platformInvoiceId: invoice.id.toString() },
    };

    await wrapped(envelope);
    await wrapped(envelope);

    expect(spyHandler).toHaveBeenCalledTimes(1);
    expect(await countConsumedRows(outboxMessageId, 'test.markPlatformInvoicePaidOnPaymentSucceeded')).toBe(1);

    const paid = await invoiceRepository.findById(invoice.id, tenantId);
    expect(paid?.status).toBe('PAID');

    await rawClient.query('DELETE FROM "platform"."PlatformInvoice" WHERE id = $1', [invoice.id.toString()]);
  });

  it(
    'deux invocations CONCURRENTES (Promise.all, course reelle) du meme handler decore pour le meme message n_appliquent l_effet qu_une seule fois — preuve de la reclamation ATOMIQUE (correctif TOCTOU, revue de securite)',
    async () => {
      const outboxMessageId = uniqueId();
      await insertDummyOutboxMessage({
        id: outboxMessageId,
        eventType: 'identity.user-account.created',
        tenantId: null,
      });

      let callCount = 0;
      const handler: OutboxEventHandler = async () => {
        // Delai artificiel : elargit DELIBEREMENT la fenetre de course pour que les DEUX
        // invocations concurrentes de `wrapped(envelope)` se chevauchent REELLEMENT (sans ce
        // delai, la premiere pourrait terminer avant que la seconde ne debute meme sa lecture,
        // masquant une race non fermee derriere une execution accidentellement sequentielle).
        await new Promise((resolve) => setTimeout(resolve, 50));
        callCount += 1;
      };
      const wrapped = withOutboxIdempotency(prisma, 'test.concurrent-consumer', handler);
      const envelope: OutboxEventEnvelope = {
        id: outboxMessageId,
        eventType: 'identity.user-account.created',
        eventVersion: 1,
        aggregateId: outboxMessageId,
        tenantId: null,
        occurredAt: new Date(),
        payload: {},
      };

      await Promise.all([wrapped(envelope), wrapped(envelope)]);

      expect(callCount).toBe(1);
      expect(await countConsumedRows(outboxMessageId, 'test.concurrent-consumer')).toBe(1);
    },
  );
});
