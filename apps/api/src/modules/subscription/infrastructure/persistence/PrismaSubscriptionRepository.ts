import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { writeDomainEventsToOutbox } from '../../../../shared-kernel/infrastructure/persistence/OutboxWriter.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { Subscription } from '../../domain/Subscription.js';
import {
  SubscriptionConcurrencyConflictError,
  type SubscriptionRepository,
} from '../../domain/ports/SubscriptionRepository.js';
import type { BillingPeriod } from '../../domain/value-objects/BillingPeriod.js';
import { PlanId } from '../../domain/value-objects/PlanId.js';
import { PlanPriceId } from '../../domain/value-objects/PlanPriceId.js';
import { SubscriptionId } from '../../domain/value-objects/SubscriptionId.js';
import type { SubscriptionStatus } from '../../domain/value-objects/SubscriptionStatus.js';

interface SubscriptionRow {
  id: string;
  tenantId: string;
  planId: string;
  currentPlanPriceId: string;
  period: string;
  status: string;
  trialEndsAt: Date | null;
  periodStartsAt: Date;
  periodEndsAt: Date;
  createdAt: Date;
  gracePeriodStartedAt: Date | null;
  degradedModeEnteredAt: Date | null;
  degradedModeSustainedNotifiedAt: Date | null;
  version: number;
}

/**
 * Repository `Subscription` — table `platform.Subscription`, `tenant_id` colonne simple,
 * EXPLICITEMENT SANS RLS (ADR-0001 §3.3). Chaque methode filtre `tenant_id` EN PLUS de l'id
 * quand un id est fourni : contrairement aux tables `public/` protegees par RLS FORCE (couche 4
 * de rattrapage), CE FILTRE EST ICI LA SEULE BARRIERE — un oubli sur cette classe serait une
 * fuite inter-tenant reelle et immediate, pas seulement une degradation de la defense en
 * profondeur. Voir test/subscription/integration/subscriptionRepositoryTenantIsolation.test.ts,
 * qui le demontre explicitement en interrogeant volontairement avec un tenantId different du
 * proprietaire reel.
 */
export class PrismaSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Version optimiste lue en base, associee a l'INSTANCE `Subscription` retournee par `toDomain()`
   * (jamais a son id : deux relectures successives du meme id produisent deux instances DISTINCTES,
   * chacune retenant la version qu'ELLE a lue — c'est ce qui permet a `save()` de detecter qu'un
   * AUTRE writer a ecrit entre-temps). Replique EXACTE du mecanisme de
   * `PrismaPaymentRepository.ts` : `version` est PUREMENT technique, absente de `SubscriptionProps`
   * et donc connue de ce seul repository. Un `Subscription` construit par `startTrial()` (jamais
   * passe par `toDomain()`) est absent de cette map : traite comme version `0` (premiere ecriture,
   * branche CREATE de `save()`).
   */
  private readonly versionsByInstance = new WeakMap<Subscription, number>();

  async findByTenantId(tenantId: TenantId): Promise<Subscription | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.subscription.findFirst({ where: { tenantId: tenantId.toString() } });
    return row === null ? null : this.toDomain(row);
  }

  async findById(id: SubscriptionId, tenantId: TenantId): Promise<Subscription | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.subscription.findFirst({
      where: { id: id.toString(), tenantId: tenantId.toString() },
    });
    return row === null ? null : this.toDomain(row);
  }

  /**
   * VERROUILLAGE OPTIMISTE (passe 2) — l'`upsert()` d'origine est remplace par un
   * `findUnique` + CREATE/UPDATE explicites : le controle de version DOIT etre applique AVANT de
   * decider la branche, ce qu'un `upsert()` atomique ne laisse pas exprimer.
   *
   * Branche CREATE : `version` demarre a 0, meme mecanisme que `PrismaPaymentRepository.save()` —
   * `createMany({ skipDuplicates: true })` (`INSERT ... ON CONFLICT DO NOTHING`) PLUTOT qu'un
   * `create()` rattrapant le `P2002` : cette methode est appelee DANS une transaction deja ouverte
   * (`StartTrialSubscriptionHandler`, sous `unitOfWork.withTransaction`), et en PostgreSQL une
   * violation de contrainte AVORTE la transaction entiere — toute requete suivante, y compris la
   * relecture de la ligne en conflit, echouerait alors avec `25P02 current transaction is
   * aborted`. `count === 0` signifie qu'un AUTRE writer vient d'inserer une ligne pour ce MEME
   * tenant (contrainte UNIQUE `tenant_id`, invariant "un tenant = un abonnement") : si c'est LA
   * MEME ligne (meme `id`, course benigne), rien a refaire — le write etait idempotent et celui
   * qui a gagne la course a deja ecrit ses propres evenements ; si c'est un `id` DIFFERENT, deux
   * abonnements distincts pretendent au meme tenant — anomalie reelle, jamais masquee.
   *
   * Branche UPDATE : `updateMany({ where: { id, version: expectedVersion } })`, conditionnee sur la
   * version LUE par CETTE instance. `count === 0` alors que la ligne existe (verifie juste avant)
   * signifie qu'un AUTRE writer a incremente la version entre notre lecture et notre ecriture : on
   * NE l'ecrase PAS, on leve `SubscriptionConcurrencyConflictError`.
   *
   * Dans LES DEUX branches, la version retenue par l'instance est RAFRAICHIE apres une ecriture
   * reussie (CREATE -> 0, UPDATE -> expectedVersion + 1) : sans cela, un second `save()` sur le
   * MEME objet, apres une nouvelle mutation, se verrait opposer a tort une version perimee — bug
   * reel identifie et corrige sur `PrismaPaymentRepository.ts` a la revue de la passe precedente,
   * volontairement non reproduit ici.
   */
  async save(subscription: Subscription, tenantId: TenantId): Promise<void> {
    if (!subscription.tenantId.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'un Subscription hors du tenant du contexte courant.");
    }
    const client = resolvePrismaClient(this.prisma);
    const idStr = subscription.id.toString();
    const tenantIdStr = tenantId.toString();

    // `where: { id }` seul (pas de composite avec tenantId) : suffisant et coherent avec
    // PrismaHealthFacilityRepository.save / PrismaUserTenantMembershipRepository.save — l'
    // appartenance au bon tenant est deja verifiee ci-dessus (`equals`), `id` est la cle
    // primaire donc globalement unique, aucune ecriture croisee n'est possible ici.
    const existingRow = await client.subscription.findUnique({ where: { id: idStr }, select: { id: true } });

    if (existingRow === null) {
      const insertResult = await client.subscription.createMany({
        data: [
          {
            id: idStr,
            tenantId: tenantIdStr,
            planId: subscription.planId.toString(),
            currentPlanPriceId: subscription.currentPlanPriceId.toString(),
            period: subscription.period,
            status: subscription.status,
            trialEndsAt: subscription.trialEndsAt,
            periodStartsAt: subscription.periodStartsAt,
            periodEndsAt: subscription.periodEndsAt,
            createdAt: subscription.createdAt,
            gracePeriodStartedAt: subscription.gracePeriodStartedAt,
            degradedModeEnteredAt: subscription.degradedModeEnteredAt,
            degradedModeSustainedNotifiedAt: subscription.degradedModeSustainedNotifiedAt,
            version: 0,
          },
        ],
        skipDuplicates: true,
      });

      if (insertResult.count === 0) {
        const conflicting = await client.subscription.findUnique({
          where: { tenantId: tenantIdStr },
          select: { id: true },
        });
        if (conflicting === null || conflicting.id !== idStr) {
          // Soit l'insertion ignoree ne vient pas de la contrainte attendue, soit DEUX
          // abonnements distincts pretendent au meme tenant (violation de l'invariant "un tenant
          // = un abonnement") — dans les deux cas, incoherence reelle, jamais masquee.
          throw new Error(
            `Subscription ${idStr} : insertion ignoree pour cause de conflit sur le tenant ${tenantIdStr}, mais aucune ligne coherente retrouvee (incoherence de contrainte ou deux abonnements distincts pour le meme tenant).`,
          );
        }
        // Course benigne : un writer concurrent vient d'inserer EXACTEMENT cette ligne. Write
        // idempotent, aucun evenement a rejouer ici (le gagnant a deja ecrit les siens).
        return;
      }
      this.versionsByInstance.set(subscription, 0);
    } else {
      const expectedVersion = this.versionsByInstance.get(subscription) ?? 0;
      const updateResult = await client.subscription.updateMany({
        where: { id: idStr, version: expectedVersion },
        data: {
          planId: subscription.planId.toString(),
          currentPlanPriceId: subscription.currentPlanPriceId.toString(),
          status: subscription.status,
          trialEndsAt: subscription.trialEndsAt,
          periodStartsAt: subscription.periodStartsAt,
          periodEndsAt: subscription.periodEndsAt,
          gracePeriodStartedAt: subscription.gracePeriodStartedAt,
          degradedModeEnteredAt: subscription.degradedModeEnteredAt,
          degradedModeSustainedNotifiedAt: subscription.degradedModeSustainedNotifiedAt,
          version: { increment: 1 },
        },
      });
      if (updateResult.count === 0) {
        throw new SubscriptionConcurrencyConflictError(
          `Ecriture concurrente perdue sur Subscription ${idStr} : version attendue ${expectedVersion} deja depassee par un autre writer.`,
        );
      }
      this.versionsByInstance.set(subscription, expectedVersion + 1);
    }

    // Outbox (D9) : ecrit DANS LA MEME TRANSACTION que la ligne ci-dessus (meme `client`
    // resolu via `resolvePrismaClient`). Active ici, a l'etape 5, le relais pour TOUS les
    // evenements de ce module (y compris ceux de l'etape 4, SubscriptionStarted/
    // SubscriptionPlanChanged, jusqu'ici accumules sur l'agregat mais jamais persistes nulle
    // part — voir shared-kernel/infrastructure/persistence/OutboxWriter.ts).
    await writeDomainEventsToOutbox(client, subscription.pullDomainEvents());
  }

  async listSchedulerCandidates(now: Date): Promise<readonly Subscription[]> {
    const client = resolvePrismaClient(this.prisma);
    const rows = await client.subscription.findMany({
      where: {
        OR: [
          { status: { in: ['TRIALING', 'ACTIVE'] }, periodEndsAt: { lte: now } },
          { status: 'GRACE_PERIOD' },
          { status: 'DEGRADED', degradedModeSustainedNotifiedAt: null },
        ],
      },
    });
    return rows.map((row) => this.toDomain(row));
  }

  private toDomain(row: SubscriptionRow): Subscription {
    const id = assertValid(SubscriptionId.create(row.id));
    const tenantId = assertValid(TenantId.create(row.tenantId));
    const planId = assertValid(PlanId.create(row.planId));
    const currentPlanPriceId = assertValid(PlanPriceId.create(row.currentPlanPriceId));
    const subscription = Subscription.reconstitute(id, {
      tenantId,
      planId,
      currentPlanPriceId,
      period: row.period as BillingPeriod,
      status: row.status as SubscriptionStatus,
      trialEndsAt: row.trialEndsAt,
      periodStartsAt: row.periodStartsAt,
      periodEndsAt: row.periodEndsAt,
      createdAt: row.createdAt,
      gracePeriodStartedAt: row.gracePeriodStartedAt,
      degradedModeEnteredAt: row.degradedModeEnteredAt,
      degradedModeSustainedNotifiedAt: row.degradedModeSustainedNotifiedAt,
    });
    // TOUS les chemins de lecture passent par ici (`findByTenantId`, `findById`,
    // `listSchedulerCandidates`) : la version lue est donc systematiquement associee a l'instance
    // produite, sans qu'aucun chemin ne puisse l'oublier.
    this.versionsByInstance.set(subscription, row.version);
    return subscription;
  }
}
