import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlanUpgradeRequest } from '../../domain/PlanUpgradeRequest.js';
import {
  PlanUpgradeRequestConflictError,
  type PlanUpgradeRequestRepository,
} from '../../domain/ports/PlanUpgradeRequestRepository.js';
import { PlanChangeId } from '../../domain/value-objects/PlanChangeId.js';
import { PlanId } from '../../domain/value-objects/PlanId.js';
import { PlanPriceId } from '../../domain/value-objects/PlanPriceId.js';
import { SubscriptionId } from '../../domain/value-objects/SubscriptionId.js';

interface PlanUpgradeRequestRow {
  id: string;
  subscriptionId: string;
  tenantId: string;
  fromPlanId: string;
  fromPlanPriceId: string;
  toPlanId: string;
  toPlanPriceId: string;
  proratedAmount: number;
  coveredPeriodStartsAt: Date;
  coveredPeriodEndsAt: Date;
  requestedAt: Date;
  expiresAt: Date;
}

/**
 * Repository `PlanUpgradeRequest` — table `platform.SubscriptionPlanUpgradeRequest`, `tenant_id`
 * colonne simple, SANS RLS (meme regime que `PrismaSubscriptionRepository.ts` : le filtrage
 * explicite par `tenantId` sur CHAQUE methode est la seule barriere inter-tenant reelle ici).
 */
export class PrismaPlanUpgradeRequestRepository implements PlanUpgradeRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findBySubscriptionId(
    subscriptionId: SubscriptionId,
    tenantId: TenantId,
  ): Promise<PlanUpgradeRequest | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.subscriptionPlanUpgradeRequest.findFirst({
      where: { subscriptionId: subscriptionId.toString(), tenantId: tenantId.toString() },
    });
    return row === null ? null : this.toDomain(row);
  }

  async findById(id: string, tenantId: TenantId): Promise<PlanUpgradeRequest | null> {
    // `id` vient d'un payload d'evenement Outbox : valide AVANT toute requete. Sans cette garde, une
    // valeur non-UUID ferait echouer la requete au niveau du type `uuid` de PostgreSQL — une erreur
    // technique la ou le contrat du port impose un simple `null`.
    const idResult = PlanChangeId.create(id);
    if (idResult.isFailure()) {
      return null;
    }
    const client = resolvePrismaClient(this.prisma);
    const row = await client.subscriptionPlanUpgradeRequest.findFirst({
      where: { id: idResult.getValue().toString(), tenantId: tenantId.toString() },
    });
    return row === null ? null : this.toDomain(row);
  }

  /**
   * Supprime d'abord une eventuelle demande EXPIREE pour cet abonnement, puis insere la nouvelle —
   * les deux dans la transaction DEJA OUVERTE par l'appelant (voir `resolvePrismaClient`), donc
   * atomiquement : il n'existe aucun instant observable ou l'ancienne serait supprimee sans que la
   * nouvelle ne la remplace.
   *
   * Aucun pre-controle "une demande existe-t-elle deja ?" : deux requetes concurrentes le
   * passeraient toutes deux. C'est la contrainte UNIQUE `subscription_id` — donc la base, arbitre
   * unique — qui tranche la course, traduite ici en `PlanUpgradeRequestConflictError` (contrat du
   * port).
   *
   * `createMany({ skipDuplicates: true })` (soit `INSERT ... ON CONFLICT DO NOTHING`) plutot qu'un
   * `create()` dont on rattraperait le `P2002` : en PostgreSQL une violation de contrainte AVORTE
   * la transaction courante, or l'appelant capture cette erreur pour la traduire en echec METIER
   * (`UPGRADE_ALREADY_PENDING`) et continue son execution dans cette meme transaction. Meme
   * correctif que `PrismaPlatformInvoiceRepository.issue()` et `PrismaPlanChangeRepository.append()`.
   *
   * Le `deleteMany` qui precede reste sans consequence en cas de conflit : la contrainte UNIQUE
   * garantit AU PLUS une demande par abonnement, donc "une demande expiree a ete supprimee" et
   * "une demande non expiree bloque l'insertion" sont deux cas mutuellement exclusifs.
   */
  async replaceExpiredAndInsert(request: PlanUpgradeRequest, tenantId: TenantId, now: Date): Promise<void> {
    if (!request.tenantId.equals(tenantId)) {
      throw new Error("Tentative d'ecriture d'une PlanUpgradeRequest hors du tenant du contexte courant.");
    }
    const client = resolvePrismaClient(this.prisma);

    await client.subscriptionPlanUpgradeRequest.deleteMany({
      where: {
        subscriptionId: request.subscriptionId.toString(),
        tenantId: tenantId.toString(),
        expiresAt: { lte: now },
      },
    });

    const insertResult = await client.subscriptionPlanUpgradeRequest.createMany({
      data: [
        {
          id: request.id.toString(),
          subscriptionId: request.subscriptionId.toString(),
          tenantId: tenantId.toString(),
          fromPlanId: request.fromPlanId.toString(),
          fromPlanPriceId: request.fromPlanPriceId.toString(),
          toPlanId: request.toPlanId.toString(),
          toPlanPriceId: request.toPlanPriceId.toString(),
          proratedAmount: request.proratedAmount.amount,
          coveredPeriodStartsAt: request.coveredPeriodStartsAt,
          coveredPeriodEndsAt: request.coveredPeriodEndsAt,
          requestedAt: request.requestedAt,
          expiresAt: request.expiresAt,
        },
      ],
      skipDuplicates: true,
    });

    if (insertResult.count === 0) {
      throw new PlanUpgradeRequestConflictError(
        `Une demande d'upgrade non expiree existe deja pour l'abonnement ${request.subscriptionId.toString()}.`,
      );
    }
  }

  async delete(id: string, tenantId: TenantId): Promise<void> {
    const idResult = PlanChangeId.create(id);
    if (idResult.isFailure()) {
      return;
    }
    const client = resolvePrismaClient(this.prisma);
    // `deleteMany` (pas `delete`) : filtre le tenant EN PLUS de l'id, et reste sans effet si la
    // ligne a deja disparu — une re-livraison Outbox ne doit jamais echouer sur une suppression
    // deja effectuee.
    await client.subscriptionPlanUpgradeRequest.deleteMany({
      where: { id: idResult.getValue().toString(), tenantId: tenantId.toString() },
    });
  }

  private toDomain(row: PlanUpgradeRequestRow): PlanUpgradeRequest {
    const id = assertValid(PlanChangeId.create(row.id));
    const subscriptionId = assertValid(SubscriptionId.create(row.subscriptionId));
    const tenantId = assertValid(TenantId.create(row.tenantId));
    const fromPlanId = assertValid(PlanId.create(row.fromPlanId));
    const fromPlanPriceId = assertValid(PlanPriceId.create(row.fromPlanPriceId));
    const toPlanId = assertValid(PlanId.create(row.toPlanId));
    const toPlanPriceId = assertValid(PlanPriceId.create(row.toPlanPriceId));
    const proratedAmount = assertValid(Money.fromXOF(row.proratedAmount));
    return PlanUpgradeRequest.reconstitute(id, {
      subscriptionId,
      tenantId,
      fromPlanId,
      fromPlanPriceId,
      toPlanId,
      toPlanPriceId,
      proratedAmount,
      coveredPeriodStartsAt: row.coveredPeriodStartsAt,
      coveredPeriodEndsAt: row.coveredPeriodEndsAt,
      requestedAt: row.requestedAt,
      expiresAt: row.expiresAt,
    });
  }
}
