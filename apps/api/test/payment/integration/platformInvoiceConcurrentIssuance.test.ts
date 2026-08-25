import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { Money } from '../../../src/shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { PlatformInvoice } from '../../../src/modules/payment/domain/PlatformInvoice.js';
import { PrismaPlatformInvoiceRepository } from '../../../src/modules/payment/infrastructure/persistence/PrismaPlatformInvoiceRepository.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Adversarial : "deux renouvellements concurrents" (accès concurrent, verrouillage/idempotence
 * correct). Simule DEUX emissions concurrentes de `PlatformInvoice` pour LE MEME
 * `(subscriptionId, periodStartsAt)` — exactement le cas de deux cycles de scheduler qui se
 * chevauchent, ou d'une re-livraison Outbox de `SubscriptionRenewalDue` pendant que le premier
 * traitement est encore en cours. La contrainte UNIQUE `(subscription_id, period_starts_at)`
 * (migration SQL) est la SEULE barriere reelle ici — ce test prouve qu'elle produit bien
 * exactement UNE ligne, jamais deux, et que `PlatformInvoiceRepository.issue()` reste IDEMPOTENT
 * du point de vue de l'appelant (jamais d'exception propagee au niveau applicatif).
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('PlatformInvoice — emission concurrente idempotente (contrainte UNIQUE, adversarial)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let invoiceRepository: PrismaPlatformInvoiceRepository;

  const tenantId = uniqueId();
  const subscriptionId = uniqueId();
  const periodStartsAt = new Date('2026-09-01T00:00:00Z');
  const periodEndsAt = new Date('2026-10-01T00:00:00Z');
  let createdInvoiceIds: string[] = [];

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    invoiceRepository = new PrismaPlatformInvoiceRepository(prisma);
  });

  afterAll(async () => {
    if (createdInvoiceIds.length > 0) {
      await rawClient.query('DELETE FROM "platform"."PlatformInvoice" WHERE id = ANY($1)', [createdInvoiceIds]);
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('deux appels CONCURRENTS a issue() pour la meme periode ne creent qu_UNE SEULE ligne, et renvoient tous deux une facture coherente', async () => {
    const tenant = TenantId.create(tenantId).getValue();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const amount = Money.fromXOF(35_000).getValue();

    const invoiceAttemptA = PlatformInvoice.issue({
      tenantId: tenant,
      subscriptionId,
      planPriceId: uniqueId(),
      purpose: 'RENEWAL',
      amount,
      periodStartsAt,
      periodEndsAt,
      clock,
      idGenerator,
    });
    const invoiceAttemptB = PlatformInvoice.issue({
      tenantId: tenant,
      subscriptionId,
      planPriceId: uniqueId(),
      purpose: 'RENEWAL',
      amount,
      periodStartsAt,
      periodEndsAt,
      clock,
      idGenerator,
    });

    // Vraie concurrence : les deux ecritures partent EN MEME TEMPS (Promise.all), simulant deux
    // workers/scheduler-ticks qui se chevauchent reellement au niveau de la base.
    const [resultA, resultB] = await Promise.all([
      invoiceRepository.issue(invoiceAttemptA),
      invoiceRepository.issue(invoiceAttemptB),
    ]);

    expect(resultA.id.toString()).toBe(resultB.id.toString());

    createdInvoiceIds = [invoiceAttemptA.id.toString(), invoiceAttemptB.id.toString()];
    const rows = await rawClient.query(
      'SELECT id FROM "platform"."PlatformInvoice" WHERE subscription_id = $1 AND period_starts_at = $2',
      [subscriptionId, periodStartsAt],
    );
    expect(rows.rowCount).toBe(1);
  });
});
