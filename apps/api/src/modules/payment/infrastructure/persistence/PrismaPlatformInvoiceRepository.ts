import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { writeDomainEventsToOutbox } from '../../../../shared-kernel/infrastructure/persistence/OutboxWriter.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlatformInvoice } from '../../domain/PlatformInvoice.js';
import type { PlatformInvoiceRepository } from '../../domain/ports/PlatformInvoiceRepository.js';
import { PlatformInvoiceId } from '../../domain/value-objects/PlatformInvoiceId.js';
import type { PlatformInvoicePurpose } from '../../domain/value-objects/PlatformInvoicePurpose.js';
import type { PlatformInvoiceStatus } from '../../domain/value-objects/PlatformInvoiceStatus.js';

interface PlatformInvoiceRow {
  id: string;
  tenantId: string;
  subscriptionId: string;
  planPriceId: string;
  purpose: string;
  sourceReference: string | null;
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

  async findBySourceReference(sourceReference: string, tenantId: TenantId): Promise<PlatformInvoice | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.platformInvoice.findFirst({
      where: { sourceReference, tenantId: tenantId.toString() },
    });
    return row === null ? null : this.toDomain(row);
  }

  /**
   * IDEMPOTENT (contrat du port). La table porte DEUX contraintes UNIQUE, chacune couvrant un
   * chemin d'emission : `(subscription_id, purpose, period_starts_at)` pour le renouvellement,
   * `source_reference` pour une facture declenchee par un fait metier identifie (upgrade).
   *
   * `createMany({ skipDuplicates: true })` — donc `INSERT ... ON CONFLICT DO NOTHING` — PLUTOT
   * qu'un `create()` dont on rattraperait le `P2002` : ce choix N'EST PAS cosmetique. Cette methode
   * est appelee DANS une transaction deja ouverte (voir `IssuePlatformInvoiceOnRenewalDue.ts` /
   * `IssuePlatformInvoiceOnUpgradeRequested.ts`, tous deux sous `unitOfWork.withTransaction`), et
   * en PostgreSQL une violation de contrainte AVORTE la transaction entiere : toute requete
   * suivante — y compris la relecture de la ligne en conflit — echoue alors avec
   * `25P02 current transaction is aborted`. Rattraper le `P2002` pour relire etait donc
   * structurellement impossible dans ce contexte. `ON CONFLICT DO NOTHING` ne leve rien, laisse la
   * transaction saine, et permet la relecture qui suit.
   *
   * `count === 0` signifie qu'une ligne en conflit existe deja : on la RELIT par
   * `sourceReference` quand la facture en porte une (seule contrainte qui puisse alors avoir
   * joue pour ce chemin), sinon par le triplet du renouvellement. Une relecture infructueuse
   * signalerait une contrainte inattendue : l'incoherence est alors levee explicitement, jamais
   * masquee par un retour silencieux.
   */
  async issue(invoice: PlatformInvoice): Promise<PlatformInvoice> {
    const client = resolvePrismaClient(this.prisma);
    const tenantIdStr = invoice.tenantId.toString();

    const insertResult = await client.platformInvoice.createMany({
      data: [
        {
          id: invoice.id.toString(),
          tenantId: tenantIdStr,
          subscriptionId: invoice.subscriptionId,
          planPriceId: invoice.planPriceId,
          purpose: invoice.purpose,
          sourceReference: invoice.sourceReference,
          amount: invoice.amount.amount,
          periodStartsAt: invoice.periodStartsAt,
          periodEndsAt: invoice.periodEndsAt,
          status: invoice.status,
          issuedAt: invoice.issuedAt,
          paidAt: invoice.paidAt,
        },
      ],
      skipDuplicates: true,
    });

    if (insertResult.count === 1) {
      await writeDomainEventsToOutbox(client, invoice.pullDomainEvents());
      return invoice;
    }

    // Relecture par `sourceReference` D'ABORD quand la facture en porte une : c'est la contrainte
    // la plus specifique, et la seule qui identifie le FAIT METIER a l'origine de la facture.
    // Repli sur le triplet de renouvellement sinon (ou si la reference ne designe rien, cas d'un
    // conflit sur l'autre contrainte).
    const bySourceReference =
      invoice.sourceReference === null
        ? null
        : await client.platformInvoice.findFirst({ where: { sourceReference: invoice.sourceReference } });
    const existingRow =
      bySourceReference ??
      (await client.platformInvoice.findFirst({
        where: {
          subscriptionId: invoice.subscriptionId,
          purpose: invoice.purpose,
          periodStartsAt: invoice.periodStartsAt,
        },
      }));

    if (existingRow === null) {
      throw new Error(
        `PlatformInvoice ${invoice.id.toString()} : insertion ignoree pour cause de conflit, mais aucune ligne en conflit retrouvee (incoherence de contrainte).`,
      );
    }
    // Aucun evenement a ecrire : la facture existait deja, celui qui l'a emise a deja publie les
    // siens. Les evenements accumules sur CETTE instance sont abandonnes avec elle.
    return this.toDomain(existingRow);
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
      purpose: row.purpose as PlatformInvoicePurpose,
      sourceReference: row.sourceReference,
      amount,
      periodStartsAt: row.periodStartsAt,
      periodEndsAt: row.periodEndsAt,
      status: row.status as PlatformInvoiceStatus,
      issuedAt: row.issuedAt,
      paidAt: row.paidAt,
    });
  }
}
