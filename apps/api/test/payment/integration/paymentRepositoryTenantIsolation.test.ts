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
import { PaymentId } from '../../../src/modules/payment/domain/value-objects/PaymentId.js';
import { PlatformInvoiceId } from '../../../src/modules/payment/domain/value-objects/PlatformInvoiceId.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Pendant de test/subscription/integration/subscriptionRepositoryTenantIsolation.test.ts pour
 * les tables `platform.PlatformInvoice`/`platform.Payment` (etape 5) — MEME regime que
 * `Subscription`/`SubscriptionPlanChange` : schema `platform`, AUCUNE politique RLS
 * (ADR-0001 §3.3), isolation PUREMENT APPLICATIVE. Ce test prouve que
 * `PrismaPlatformInvoiceRepository`/`PrismaPaymentRepository` eux-memes ne renvoient jamais une
 * ligne d'un autre tenant, meme interroges avec un `tenantId` different du proprietaire reel.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('Payment/PlatformInvoice — isolation inter-tenant (schema platform, sans RLS)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let invoiceRepository: PrismaPlatformInvoiceRepository;
  let paymentRepository: PrismaPaymentRepository;

  const tenantAId = uniqueId();
  const tenantBId = uniqueId();
  let invoiceAId: string;
  let invoiceBId: string;
  let paymentAId: string;
  let paymentBId: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    invoiceRepository = new PrismaPlatformInvoiceRepository(prisma);
    paymentRepository = new PrismaPaymentRepository(prisma);

    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const tenantA = TenantId.create(tenantAId).getValue();
    const tenantB = TenantId.create(tenantBId).getValue();
    const amount = Money.fromXOF(35_000).getValue();

    const invoiceA = PlatformInvoice.issue({
      tenantId: tenantA,
      subscriptionId: uniqueId(),
      planPriceId: uniqueId(),
      purpose: 'RENEWAL',
      amount,
      periodStartsAt: new Date('2026-09-01T00:00:00Z'),
      periodEndsAt: new Date('2026-10-01T00:00:00Z'),
      clock,
      idGenerator,
    });
    await invoiceRepository.issue(invoiceA);
    invoiceAId = invoiceA.id.toString();

    const invoiceB = PlatformInvoice.issue({
      tenantId: tenantB,
      subscriptionId: uniqueId(),
      planPriceId: uniqueId(),
      purpose: 'RENEWAL',
      amount,
      periodStartsAt: new Date('2026-09-01T00:00:00Z'),
      periodEndsAt: new Date('2026-10-01T00:00:00Z'),
      clock,
      idGenerator,
    });
    await invoiceRepository.issue(invoiceB);
    invoiceBId = invoiceB.id.toString();

    const paymentA = Payment.initiate({
      tenantId: tenantA,
      platformInvoiceId: invoiceA.id,
      subscriptionId: invoiceA.subscriptionId,
      purpose: 'RENEWAL',
      method: 'MOBILE_MONEY',
      amount,
      providerTransactionId: `tenant-isolation-a-${uniqueId()}`,
      clock,
      idGenerator,
    });
    await paymentRepository.save(paymentA, tenantA);
    paymentAId = paymentA.id.toString();

    const paymentB = Payment.initiate({
      tenantId: tenantB,
      platformInvoiceId: invoiceB.id,
      subscriptionId: invoiceB.subscriptionId,
      purpose: 'RENEWAL',
      method: 'CARD',
      amount,
      providerTransactionId: `tenant-isolation-b-${uniqueId()}`,
      clock,
      idGenerator,
    });
    await paymentRepository.save(paymentB, tenantB);
    paymentBId = paymentB.id.toString();
  });

  afterAll(async () => {
    await rawClient.query('DELETE FROM "platform"."Payment" WHERE id = $1 OR id = $2', [paymentAId, paymentBId]);
    await rawClient.query('DELETE FROM "platform"."PlatformInvoice" WHERE id = $1 OR id = $2', [invoiceAId, invoiceBId]);
    await rawClient.end();
    await prisma.$disconnect();
  });

  describe('PlatformInvoice', () => {
    it("findById(invoiceA, tenantB) renvoie null : un id valide d'un AUTRE tenant ne suffit jamais", async () => {
      const tenantB = TenantId.create(tenantBId).getValue();
      const result = await invoiceRepository.findById(PlatformInvoiceId.create(invoiceAId).getValue(), tenantB);
      expect(result).toBeNull();
    });

    it('findById(invoiceA, tenantA) retrouve la ligne du proprietaire legitime', async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const result = await invoiceRepository.findById(PlatformInvoiceId.create(invoiceAId).getValue(), tenantA);
      expect(result?.id.toString()).toBe(invoiceAId);
    });
  });

  describe('Payment', () => {
    it("findById(paymentA, tenantB) renvoie null", async () => {
      const tenantB = TenantId.create(tenantBId).getValue();
      const result = await paymentRepository.findById(PaymentId.create(paymentAId).getValue(), tenantB);
      expect(result).toBeNull();
    });

    it('findById(paymentA, tenantA) retrouve la ligne du proprietaire legitime', async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const result = await paymentRepository.findById(PaymentId.create(paymentAId).getValue(), tenantA);
      expect(result?.id.toString()).toBe(paymentAId);
    });

    it(
      "findByProviderTransactionId ne filtre PAS par tenant (design assume, voir domain/ports/PaymentRepository.ts) mais retrouve bien le PAYMENT CORRECT, jamais celui d'un autre providerTransactionId",
      async () => {
        const paymentA = await paymentRepository.findById(PaymentId.create(paymentAId).getValue(), TenantId.create(tenantAId).getValue());
        const result = await paymentRepository.findByProviderTransactionId(paymentA!.providerTransactionId);
        expect(result?.id.toString()).toBe(paymentAId);
        expect(result?.tenantId.toString()).toBe(tenantAId);
      },
    );
  });

  describe('ABSENCE DE RLS — contraste deliberement demontre (ADR-0001 §3.3)', () => {
    it('une requete SQL brute SANS filtre tenant_id expose les DEUX tenants sur PlatformInvoice', async () => {
      const result = await rawClient.query('SELECT tenant_id FROM "platform"."PlatformInvoice" WHERE id = ANY($1)', [
        [invoiceAId, invoiceBId],
      ]);
      const tenantIdsVisible = result.rows.map((row: { tenant_id: string }) => row.tenant_id);
      expect(tenantIdsVisible).toEqual(expect.arrayContaining([tenantAId, tenantBId]));
    });
  });
});
