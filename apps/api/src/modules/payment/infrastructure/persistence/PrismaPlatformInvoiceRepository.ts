import { Prisma, type PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { writeDomainEventsToOutbox } from '../../../../shared-kernel/infrastructure/persistence/OutboxWriter.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlatformInvoice } from '../../domain/PlatformInvoice.js';
import type { PlatformInvoiceRepository } from '../../domain/ports/PlatformInvoiceRepository.js';
import { PlatformInvoiceId } from '../../domain/value-objects/PlatformInvoiceId.js';
import type { PlatformInvoiceStatus } from '../../domain/value-objects/PlatformInvoiceStatus.js';

interface PlatformInvoiceRow {
  id: string;
  tenantId: string;
  subscriptionId: string;
  planPriceId: string;
  amount: number;
  periodStartsAt: Date;
  periodEndsAt: Date;
  status: string;
  issuedAt: Date;
  paidAt: Date | null;
}

/**
 * Repository `PlatformInvoice` — table `platform.PlatformInvoice`, `tenant_id` colonne simple,
 * SANS RLS (ADR-0001 §3.3, meme regime que `PrismaSubscriptionRepository.ts` a l'etape 4) :
 * filtrage tenant explicite sur CHAQUE methode = seule barriere inter-tenant reelle sur cette
 * table (voir test/payment/integration/paymentRepositoryTenantIsolation.test.ts).
 */
export class PrismaPlatformInvoiceRepository implements PlatformInvoiceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: PlatformInvoiceId, tenantId: TenantId): Promise<PlatformInvoice | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.platformInvoice.findFirst({
      where: { id: id.toString(), tenantId: tenantId.toString() },
    });
    return row === null ? null : this.toDomain(row);
  }

  /**
   * IDEMPOTENT (contrat du port) : si la contrainte UNIQUE `(subscription_id, period_starts_at)`
   * est violee (Prisma `P2002`), une facture existe deja pour cette periode — on la RENVOIE au
   * lieu de propager l'erreur. C'est la barriere reelle contre la double-facturation lors de
   * renouvellements concurrents (voir domain/ports/PlatformInvoiceRepository.ts).
   */
  async issue(invoice: PlatformInvoice): Promise<PlatformInvoice> {
    const client = resolvePrismaClient(this.prisma);
    const tenantIdStr = invoice.tenantId.toString();

    try {
      await client.platformInvoice.create({
        data: {
          id: invoice.id.toString(),
          tenantId: tenantIdStr,
          subscriptionId: invoice.subscriptionId,
          planPriceId: invoice.planPriceId,
          amount: invoice.amount.amount,
          periodStartsAt: invoice.periodStartsAt,
          periodEndsAt: invoice.periodEndsAt,
          status: invoice.status,
          issuedAt: invoice.issuedAt,
          paidAt: invoice.paidAt,
        },
      });
      await writeDomainEventsToOutbox(client, invoice.pullDomainEvents());
      return invoice;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existingRow = await client.platformInvoice.findFirst({
          where: { subscriptionId: invoice.subscriptionId, periodStartsAt: invoice.periodStartsAt },
        });
        if (existingRow === null) {
          // Ne devrait pas arriver (le P2002 vient forcement de cette contrainte) — remonte
          // l'erreur d'origine plutot que de masquer une incoherence.
          throw error;
        }
        return this.toDomain(existingRow);
      }
      throw error;
    }
  }

  async save(invoice: PlatformInvoice, tenantId: TenantId): Promise<void> {
    if (!invoice.tenantId.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'une PlatformInvoice hors du tenant du contexte courant.");
    }
    const client = resolvePrismaClient(this.prisma);
    await client.platformInvoice.update({
      where: { id: invoice.id.toString() },
      data: {
        status: invoice.status,
        paidAt: invoice.paidAt,
      },
    });
    await writeDomainEventsToOutbox(client, invoice.pullDomainEvents());
  }

  private toDomain(row: PlatformInvoiceRow): PlatformInvoice {
    const id = assertValid(PlatformInvoiceId.create(row.id));
    const tenantId = assertValid(TenantId.create(row.tenantId));
    const amount = assertValid(Money.fromXOF(row.amount));
    return PlatformInvoice.reconstitute(id, {
      tenantId,
      subscriptionId: row.subscriptionId,
      planPriceId: row.planPriceId,
      amount,
      periodStartsAt: row.periodStartsAt,
      periodEndsAt: row.periodEndsAt,
      status: row.status as PlatformInvoiceStatus,
      issuedAt: row.issuedAt,
      paidAt: row.paidAt,
    });
  }
}
