import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { Money } from '../../../src/shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { PlatformInvoice } from '../../../src/modules/payment/domain/PlatformInvoice.js';
import { createIssuePlatformInvoiceOnUpgradeRequestedHandler } from '../../../src/modules/payment/application/services/IssuePlatformInvoiceOnUpgradeRequested.js';
import { PrismaPlatformInvoiceRepository } from '../../../src/modules/payment/infrastructure/persistence/PrismaPlatformInvoiceRepository.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Couvre les DEUX consequences de la generalisation de la contrainte UNIQUE de
 * `platform.PlatformInvoice` (migration 20260825090000) :
 *
 * (a) `(subscription_id, purpose, period_starts_at)` remplace `(subscription_id, period_starts_at)`.
 *     Une facture d'UPGRADE et une facture de RENOUVELLEMENT peuvent desormais coexister pour le
 *     MEME abonnement sur la MEME periode — ce test AURAIT ECHOUE avec l'ancienne cle, et c'est
 *     precisement le blocage qui empechait de facturer un upgrade proratise a l'interieur d'un
 *     cycle deja facture.
 *
 * (b) `source_reference` UNIQUE rend `IssuePlatformInvoiceOnUpgradeRequested` idempotent PAR
 *     CONSTRUCTION : une re-livraison Outbox at-least-once du meme `SubscriptionUpgradeRequested`
 *     ne cree jamais une seconde facture, donc ne facture jamais deux fois le meme upgrade.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('PlatformInvoice — facture d_UPGRADE (coexistence avec le renouvellement + idempotence par sourceReference)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let invoiceRepository: PrismaPlatformInvoiceRepository;

  const tenantIdValue = uniqueId();
  const subscriptionId = uniqueId();
  const planChangeId = uniqueId();
  const periodStartsAt = new Date('2026-09-01T00:00:00Z');
  const periodEndsAt = new Date('2026-10-01T00:00:00Z');

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    invoiceRepository = new PrismaPlatformInvoiceRepository(prisma);
  });

  afterAll(async () => {
    await rawClient.query('DELETE FROM "platform"."PlatformInvoice" WHERE tenant_id = $1', [tenantIdValue]);
    await rawClient.query('DELETE FROM "platform"."OutboxMessage" WHERE tenant_id = $1', [tenantIdValue]);
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('(a) une facture de RENOUVELLEMENT et une facture d_UPGRADE coexistent pour le MEME (subscriptionId, periodStartsAt)', async () => {
    const tenant = TenantId.create(tenantIdValue).getValue();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();

    const renewalInvoice = PlatformInvoice.issue({
      tenantId: tenant,
      subscriptionId,
      planPriceId: uniqueId(),
      purpose: 'RENEWAL',
      amount: Money.fromXOF(35_000).getValue(),
      periodStartsAt,
      periodEndsAt,
      clock,
      idGenerator,
    });
    const upgradeInvoice = PlatformInvoice.issue({
      tenantId: tenant,
      subscriptionId,
      planPriceId: uniqueId(),
      purpose: 'UPGRADE',
      sourceReference: uniqueId(),
      amount: Money.fromXOF(10_000).getValue(),
      periodStartsAt,
      periodEndsAt,
      clock,
      idGenerator,
    });

    await invoiceRepository.issue(renewalInvoice);
    await invoiceRepository.issue(upgradeInvoice);

    // Les DEUX lignes doivent exister : c'est l'assertion qui echouerait sous l'ancienne contrainte.
    const rows = await rawClient.query(
      'SELECT id, purpose FROM "platform"."PlatformInvoice" WHERE subscription_id = $1 AND period_starts_at = $2 ORDER BY purpose',
      [subscriptionId, periodStartsAt],
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows.map((row: { purpose: string }) => row.purpose)).toEqual(['RENEWAL', 'UPGRADE']);
  });

  it('(b) double livraison Outbox du MEME SubscriptionUpgradeRequested : une seule facture d_upgrade creee', async () => {
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const handler = createIssuePlatformInvoiceOnUpgradeRequestedHandler({
      platformInvoiceRepository: invoiceRepository,
      unitOfWork: new PgUnitOfWork(prisma),
      clock,
      idGenerator,
    });

    const upgradeSubscriptionId = uniqueId();
    const envelope = {
      id: 'outbox-upgrade-1',
      eventType: 'subscription.subscription.upgrade-requested',
      eventVersion: 1,
      aggregateId: upgradeSubscriptionId,
      tenantId: tenantIdValue,
      occurredAt: new Date('2026-09-16T10:00:00Z'),
      payload: {
        tenantId: tenantIdValue,
        planChangeId,
        fromPlanId: uniqueId(),
        fromPlanPriceId: uniqueId(),
        toPlanId: uniqueId(),
        toPlanPriceId: uniqueId(),
        proratedAmountXof: 10_000,
        coveredPeriodStartsAt: '2026-09-16T10:00:00.000Z',
        coveredPeriodEndsAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-09-17T10:00:00.000Z',
      },
    };

    // Deux livraisons SEQUENTIELLES du meme message (cas le plus courant d'un relais at-least-once :
    // le premier traitement a reussi mais l'acquittement s'est perdu).
    await handler(envelope);
    await handler(envelope);

    const rows = await rawClient.query(
      'SELECT id, amount FROM "platform"."PlatformInvoice" WHERE source_reference = $1',
      [planChangeId],
    );
    expect(rows.rowCount).toBe(1);
    expect((rows.rows[0] as { amount: number }).amount).toBe(10_000);
  });

  it('(b bis) deux livraisons CONCURRENTES du meme evenement : la contrainte UNIQUE source_reference tranche, une seule facture', async () => {
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const handler = createIssuePlatformInvoiceOnUpgradeRequestedHandler({
      platformInvoiceRepository: invoiceRepository,
      unitOfWork: new PgUnitOfWork(prisma),
      clock,
      idGenerator,
    });

    const concurrentPlanChangeId = uniqueId();
    const envelope = {
      id: 'outbox-upgrade-2',
      eventType: 'subscription.subscription.upgrade-requested',
      eventVersion: 1,
      aggregateId: uniqueId(),
      tenantId: tenantIdValue,
      occurredAt: new Date('2026-09-16T10:00:00Z'),
      payload: {
        tenantId: tenantIdValue,
        planChangeId: concurrentPlanChangeId,
        fromPlanId: uniqueId(),
        fromPlanPriceId: uniqueId(),
        toPlanId: uniqueId(),
        toPlanPriceId: uniqueId(),
        proratedAmountXof: 7_500,
        coveredPeriodStartsAt: '2026-09-16T10:00:00.000Z',
        coveredPeriodEndsAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-09-17T10:00:00.000Z',
      },
    };

    // Vraie concurrence : deux workers du relais traitent le meme message en meme temps.
    const outcomes = await Promise.allSettled([handler(envelope), handler(envelope)]);
    // Aucun des deux ne doit remonter d'erreur : `issue()` absorbe le P2002 en relisant la ligne
    // gagnante (discrimination par `error.meta.target`, voir PrismaPlatformInvoiceRepository).
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);

    const rows = await rawClient.query(
      'SELECT id FROM "platform"."PlatformInvoice" WHERE source_reference = $1',
      [concurrentPlanChangeId],
    );
    expect(rows.rowCount).toBe(1);
  });
});
