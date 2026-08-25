import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { Money } from '../../../src/shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Payment } from '../../../src/modules/payment/domain/Payment.js';
import { PlatformInvoice } from '../../../src/modules/payment/domain/PlatformInvoice.js';
import { PrismaPaymentRepository } from '../../../src/modules/payment/infrastructure/persistence/PrismaPaymentRepository.js';
import { PrismaPlatformInvoiceRepository } from '../../../src/modules/payment/infrastructure/persistence/PrismaPlatformInvoiceRepository.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Adversarial : deux agregats `Payment` DISTINCTS (deux `id` differents) forces sur le MEME
 * `providerTransactionId` — situation qui ne devrait JAMAIS se produire si le prestataire attribue
 * des identifiants de transaction uniques (voir le commentaire "anomalie reelle" de
 * `PrismaPaymentRepository.save()`), mais que ce test verifie neanmoins explicitement : la
 * contrainte UNIQUE `provider_transaction_id` (migration `20260824100000_payment_outbox_init`)
 * est la SEULE barriere reelle, et `save()` doit la gerer sans jamais laisser deux lignes
 * coexister, ni masquer silencieusement l'anomalie du perdant.
 *
 * A distinguer du cas BENIN documente dans `save()` (meme `id`, deux ecritures concurrentes du
 * MEME `Payment`) : ICI, les deux `id` sont volontairement DIFFERENTS, donc le perdant de la
 * course DOIT recevoir une erreur explicite (jamais avalee) plutot qu'un retour silencieux.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('Payment — deux agregats DISTINCTS forces sur le MEME providerTransactionId (contrainte UNIQUE, adversarial)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let paymentRepository: PrismaPaymentRepository;
  let invoiceRepository: PrismaPlatformInvoiceRepository;
  let invoice: PlatformInvoice;
  let tenant: TenantId;

  const tenantId = uniqueId();
  const sharedProviderTransactionId = `concurrency-${uniqueId()}`;
  let paymentAId: string;
  let paymentBId: string;

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
    const ids = [paymentAId, paymentBId].filter((id): id is string => id !== undefined);
    if (ids.length > 0) {
      await rawClient.query('DELETE FROM "platform"."Payment" WHERE id = ANY($1)', [ids]);
    }
    await rawClient.query('DELETE FROM "platform"."PlatformInvoice" WHERE id = $1', [invoice.id.toString()]);
    await rawClient.end();
    await prisma.$disconnect();
  });

  it(
    'un seul appel a save() gagne (une seule ligne pour ce providerTransactionId), le perdant echoue EXPLICITEMENT, aucune exception non geree pour le cas benin ne s_applique ici (id differents)',
    async () => {
      const clock = new SystemClock();
      const idGenerator = new UuidGenerator();

      const paymentA = Payment.initiate({
        tenantId: tenant,
        platformInvoiceId: invoice.id,
        subscriptionId: invoice.subscriptionId,
        purpose: 'RENEWAL',
        method: 'MOBILE_MONEY',
        amount: invoice.amount,
        providerTransactionId: sharedProviderTransactionId,
        clock,
        idGenerator,
      });
      const paymentB = Payment.initiate({
        tenantId: tenant,
        platformInvoiceId: invoice.id,
        subscriptionId: invoice.subscriptionId,
        purpose: 'RENEWAL',
        method: 'CARD',
        amount: invoice.amount,
        providerTransactionId: sharedProviderTransactionId,
        clock,
        idGenerator,
      });
      paymentAId = paymentA.id.toString();
      paymentBId = paymentB.id.toString();
      expect(paymentAId).not.toBe(paymentBId);

      // Vraie concurrence : les deux ecritures partent EN MEME TEMPS (Promise.allSettled — l'un
      // des deux DOIT echouer ici, contrairement au test d'idempotence de PlatformInvoice.issue()).
      const [resultA, resultB] = await Promise.allSettled([
        paymentRepository.save(paymentA, tenant),
        paymentRepository.save(paymentB, tenant),
      ]);

      const outcomes = [resultA, resultB];
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

      const rows = await rawClient.query('SELECT id FROM "platform"."Payment" WHERE provider_transaction_id = $1', [
        sharedProviderTransactionId,
      ]);
      expect(rows.rowCount).toBe(1);
    },
  );
});
