import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlanChange } from '../../domain/PlanChange.js';
import type { PlanChangeRepository } from '../../domain/ports/PlanChangeRepository.js';
import { PlanChangeId } from '../../domain/value-objects/PlanChangeId.js';
import type { PlanChangeType } from '../../domain/value-objects/PlanChangeType.js';
import { PlanId } from '../../domain/value-objects/PlanId.js';
import { PlanPriceId } from '../../domain/value-objects/PlanPriceId.js';
import { SubscriptionId } from '../../domain/value-objects/SubscriptionId.js';

interface PlanChangeRow {
  id: string;
  subscriptionId: string;
  tenantId: string;
  changeType: string;
  fromPlanId: string;
  fromPlanPriceId: string;
  toPlanId: string;
  toPlanPriceId: string;
  proratedAmount: number;
  requestedAt: Date | null;
  platformInvoiceId: string | null;
  occurredAt: Date;
}

/**
 * Repository `PlanChange` — table `platform.SubscriptionPlanChange`, `tenant_id` colonne simple,
 * SANS RLS (meme regime que `PrismaSubscriptionRepository.ts` : filtrage explicite par
 * `tenantId` = seule barriere inter-tenant reelle sur cette table).
 */
export class PrismaPlanChangeRepository implements PlanChangeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * IDEMPOTENT PAR CLE PRIMAIRE (contrat du port, passe 2) : une ligne portant deja cet `id` est un
   * NO-OP SILENCIEUX — re-livraison at-least-once du meme `SaaSPaymentSucceeded` (l'identifiant est
   * desormais PRE-ATTRIBUE a la demande, donc previsible). L'entite etant immuable, "la ligne existe
   * deja avec cet id" signifie necessairement "avec exactement ce contenu".
   *
   * `createMany({ skipDuplicates: true })` — soit `INSERT ... ON CONFLICT DO NOTHING` — et NON un
   * `create()` dont on rattraperait le `P2002` : cette methode est appelee DANS une transaction qui
   * ecrit ENSUITE (suppression de la `PlanUpgradeRequest`, sauvegarde de l'agregat), et en
   * PostgreSQL une violation de contrainte avorte la transaction entiere — toute requete suivante
   * echouerait alors en `25P02`. Meme raisonnement et meme correctif que
   * `PrismaPlatformInvoiceRepository.issue()`.
   */
  async append(change: PlanChange, tenantId: TenantId): Promise<void> {
    if (!change.tenantId.equals(tenantId)) {
      throw new Error("Tentative d'ajout d'un PlanChange hors du tenant du contexte courant.");
    }
    const client = resolvePrismaClient(this.prisma);
    await client.subscriptionPlanChange.createMany({
      data: [
        {
          id: change.id.toString(),
          subscriptionId: change.subscriptionId.toString(),
          tenantId: tenantId.toString(),
          changeType: change.changeType,
          fromPlanId: change.fromPlanId.toString(),
          fromPlanPriceId: change.fromPlanPriceId.toString(),
          toPlanId: change.toPlanId.toString(),
          toPlanPriceId: change.toPlanPriceId.toString(),
          proratedAmount: change.proratedAmount.amount,
          requestedAt: change.requestedAt,
          platformInvoiceId: change.platformInvoiceId,
          occurredAt: change.occurredAt,
        },
      ],
      skipDuplicates: true,
    });
  }

  async findById(id: string, tenantId: TenantId): Promise<PlanChange | null> {
    // Meme garde que `PrismaPlanUpgradeRequestRepository.findById` : `id` provient d'un payload
    // d'evenement Outbox, une valeur non-UUID doit produire `null`, pas une erreur SQL.
    const idResult = PlanChangeId.create(id);
    if (idResult.isFailure()) {
      return null;
    }
    const client = resolvePrismaClient(this.prisma);
    const row = await client.subscriptionPlanChange.findFirst({
      where: { id: idResult.getValue().toString(), tenantId: tenantId.toString() },
    });
    return row === null ? null : this.toDomain(row);
  }

  async listBySubscriptionId(subscriptionId: SubscriptionId, tenantId: TenantId): Promise<readonly PlanChange[]> {
    const client = resolvePrismaClient(this.prisma);
    const rows = await client.subscriptionPlanChange.findMany({
      where: { subscriptionId: subscriptionId.toString(), tenantId: tenantId.toString() },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((row) => this.toDomain(row));
  }

  private toDomain(row: PlanChangeRow): PlanChange {
    const id = assertValid(PlanChangeId.create(row.id));
    const subscriptionId = assertValid(SubscriptionId.create(row.subscriptionId));
    const tenantId = assertValid(TenantId.create(row.tenantId));
    const fromPlanId = assertValid(PlanId.create(row.fromPlanId));
    const fromPlanPriceId = assertValid(PlanPriceId.create(row.fromPlanPriceId));
    const toPlanId = assertValid(PlanId.create(row.toPlanId));
    const toPlanPriceId = assertValid(PlanPriceId.create(row.toPlanPriceId));
    const proratedAmount = assertValid(Money.fromXOF(row.proratedAmount));
    return PlanChange.reconstitute(id, {
      subscriptionId,
      tenantId,
      changeType: row.changeType as PlanChangeType,
      fromPlanId,
      fromPlanPriceId,
      toPlanId,
      toPlanPriceId,
      proratedAmount,
      // Lignes anterieures a la passe 2 : demande et application etaient simultanees, `occurred_at`
      // est donc la valeur exacte de `requestedAt` (voir le backfill de la migration 20260825090000
      // — ce repli couvre le cas d'une ligne ecrite hors de ce chemin).
      requestedAt: row.requestedAt ?? row.occurredAt,
      platformInvoiceId: row.platformInvoiceId,
      occurredAt: row.occurredAt,
    });
  }
}
