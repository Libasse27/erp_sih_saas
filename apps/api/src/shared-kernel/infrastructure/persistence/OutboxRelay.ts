import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { buildOutboxJobId, type OutboxJobData } from '../queue/OutboxJob.js';
import {
  OUTBOX_DEFAULT_BATCH_SIZE,
  OUTBOX_DEFAULT_STALE_LOCK_MINUTES,
  OUTBOX_MAX_ERROR_LENGTH,
} from './OutboxRetryPolicy.js';

/**
 * Relais Outbox — DECOUVRE les messages `platform.OutboxMessage` non traites (D9,
 * 01-target-architecture.md §9.3) et les pousse comme jobs BullMQ pour distribution/traitement
 * (ADR-0004, etape 6/13).
 *
 * DECISION D'IMPLEMENTATION (etape 6, ADR-0004 — remplace la decision de polling pur actee a
 * l'etape 5) : le polling SQL periodique (`SELECT ... FOR UPDATE SKIP LOCKED`) N'EST PAS
 * abandonne — il reste la SEULE maniere sure de decouvrir de nouveaux messages `PENDING` et de
 * recuperer un message dont le worker precedent a crashe (`locked_at` perime), sans dupliquer
 * cette logique dans Redis. Ce qui change : une fois une ligne RECLAMEE (verrouillee, `attempts`
 * incremente), elle n'est plus traitee INLINE dans ce meme cycle — elle est ENFILEE comme job
 * BullMQ et c'est `shared-kernel/infrastructure/queue/OutboxWorker.ts` qui invoque reellement les
 * handlers, potentiellement sur un ou plusieurs workers concurrents avec une concurrence
 * configurable — c'est ce que BullMQ apporte que `SKIP LOCKED` seul n'offrait pas (distribution de
 * CHARGE, pas seulement de LOCK).
 *
 * SECURITE (correctif post-revue, etape 6) : la charge du job (`OutboxJobData`) ne porte QUE
 * l'identifiant de la ligne — jamais `eventType`/`tenantId`/`payload`/`attempts`. Redis n'est PAS
 * une source de verite : `OutboxWorker.ts` relit systematiquement la ligne reelle depuis Postgres
 * avant d'invoquer un handler. Voir le commentaire de tete de `OutboxJob.ts` pour la justification
 * complete (frontiere de confiance : Redis est accessible reseau, potentiellement compromis, ne
 * doit jamais pouvoir forger un `tenantId` ou un `eventType`).
 *
 * Repartition des responsabilites (a ne jamais confondre) :
 *   - Postgres (`OutboxMessage.status/attempts/locked_at/locked_by`) reste la SEULE source de
 *     verite de la semantique at-least-once, de la reprise apres crash et du dead-letter — voir
 *     `OutboxRetryPolicy.ts`. Un job BullMQ perdu (Redis vide/flush) n'est jamais une perte de
 *     message : le prochain cycle de ce relais reclame la ligne encore `PENDING`/`PROCESSING`
 *     perimee et la ré-enfile.
 *   - BullMQ (Redis) ne fait QUE distribuer la charge de traitement — ses propres compteurs de
 *     retry/attempts sont volontairement DESACTIVES (`attempts: 1` a l'ajout, voir plus bas) : la
 *     decision PENDING/FAILED apres un echec est prise par `OutboxWorker.ts` a partir du compteur
 *     Postgres, jamais par le mecanisme de retry interne de BullMQ, pour n'avoir qu'UNE seule
 *     politique de nouvelle tentative, jamais deux qui pourraient diverger.
 *   - NUANCE (revue post-implementation) : le mecanisme de "stalled jobs" PROPRE a BullMQ (voir
 *     OutboxWorker.ts, `lockDuration`/`stalledInterval`) peut redistribuer un job a un autre
 *     worker BIEN PLUS VITE que `staleLockMinutes` (5 minutes) ne reclame la ligne cote Postgres.
 *     Ce n'est plus une incoherence dangereuse depuis que `OutboxWorker.ts` revalide `attempts`
 *     (via `jobId`, voir `buildOutboxJobId`) et `locked_by` a chaque invocation — un job redistribue
 *     pour une generation PERIMEE est un no-op silencieux, jamais un double traitement. La reprise
 *     "au sens strict" (une ligne dont le VERROU POSTGRES est perime) reste bien pilotee par
 *     `staleLockMinutes` ; celle "au sens BullMQ" (un job Redis stalled) est plus rapide mais sans
 *     consequence sur la source de verite.
 *
 * Si l'enfilage BullMQ lui-meme echoue (Redis indisponible), la ligne est immediatement rendue
 * `PENDING` et son compteur `attempts` DECREMENTE (voir plus bas) : une reclamation qui n'a jamais
 * ete suivie d'un enfilage reussi n'est PAS une tentative de traitement — sans cela, une simple
 * coupure Redis transitoire ferait deraper le compteur de dead-letter d'un evenement financier
 * legitime.
 */

export interface OutboxRelayLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface OutboxRelayOptions {
  readonly prisma: PrismaClient;
  readonly queue: Queue<OutboxJobData>;
  readonly workerId: string;
  readonly batchSize?: number;
  readonly staleLockMinutes?: number;
  readonly logger?: OutboxRelayLogger;
}

export interface OutboxRelayRunSummary {
  readonly claimed: number;
  readonly enqueued: number;
  readonly enqueueFailed: number;
}

interface ClaimedOutboxRow {
  id: string;
  eventType: string;
  attempts: number;
}

/**
 * Reclame un lot de messages `PENDING` (ou `PROCESSING` depuis trop longtemps — recuperation apres
 * crash d'un worker) : `FOR UPDATE SKIP LOCKED` permet a plusieurs PROCESSUS de ce relais (pas
 * seulement plusieurs workers BullMQ, qui eux tournent dans le MEME processus consommateur, voir
 * OutboxWorker.ts) de tourner en parallele sans se bloquer ni se doubler.
 *
 * Ne renvoie QUE `id`/`eventType`/`attempts` — `eventType` sert uniquement de NOM de job BullMQ
 * (observabilite, donnee non sensible), `attempts` sert a construire le `jobId` (voir
 * `buildOutboxJobId`). Le reste de la ligne (`tenantId`, `payload`...) n'est PLUS lu ici : seul
 * `OutboxWorker.ts`, juste avant d'invoquer un handler, le relit depuis Postgres — jamais transmis
 * via Redis (voir le commentaire de tete de fichier).
 */
async function claimOutboxBatch(
  prisma: PrismaClient,
  params: { batchSize: number; staleLockMinutes: number; workerId: string },
): Promise<ClaimedOutboxRow[]> {
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - params.staleLockMinutes * 60_000);

  return prisma.$transaction(async (tx) => {
    return tx.$queryRaw<ClaimedOutboxRow[]>`
      UPDATE "platform"."OutboxMessage"
      SET status = 'PROCESSING'::"platform"."OutboxMessageStatus",
          locked_at = ${now},
          locked_by = ${params.workerId},
          attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM "platform"."OutboxMessage"
        WHERE status = 'PENDING'::"platform"."OutboxMessageStatus"
           OR (status = 'PROCESSING'::"platform"."OutboxMessageStatus" AND locked_at < ${staleLockBefore})
        ORDER BY occurred_at ASC
        LIMIT ${params.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id,
        event_type AS "eventType",
        attempts;
    `;
  });
}

/** Execute UN cycle de relais : reclame un lot puis l'enfile sur la file BullMQ (voir commentaire de tete de fichier). */
export async function relayOutboxOnce(options: OutboxRelayOptions): Promise<OutboxRelayRunSummary> {
  const batchSize = options.batchSize ?? OUTBOX_DEFAULT_BATCH_SIZE;
  const staleLockMinutes = options.staleLockMinutes ?? OUTBOX_DEFAULT_STALE_LOCK_MINUTES;

  const claimed = await claimOutboxBatch(options.prisma, {
    batchSize,
    staleLockMinutes,
    workerId: options.workerId,
  });

  let enqueued = 0;
  let enqueueFailed = 0;

  for (const row of claimed) {
    const jobData: OutboxJobData = { id: row.id };

    try {
      // `jobId` inclut `attempts` (voir `buildOutboxJobId`) : chaque RECLAMATION produit un
      // identifiant de job BullMQ distinct, jamais une simple reutilisation de `row.id` — voir le
      // commentaire de tete de OutboxJob.ts pour la justification (interaction avec le mecanisme
      // de "stalled jobs" de BullMQ). `attempts: 1` : AUCUN retry BullMQ (voir commentaire de tete
      // de fichier). `removeOnComplete`/`removeOnFail` : Redis ne doit jamais accumuler
      // l'historique de ces jobs, deja trace dans Postgres.
      await options.queue.add(row.eventType, jobData, {
        jobId: buildOutboxJobId(row.id, row.attempts),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      });
      enqueued += 1;
    } catch (error) {
      enqueueFailed += 1;
      // Ne bloque PAS jusqu'a expiration du verrou : liberation immediate (retente au prochain
      // cycle) plutot que d'attendre `staleLockMinutes` pour une panne d'enfilage detectee tout de
      // suite. `attempts: { decrement: 1 }` : ANNULE l'incrementation faite par la reclamation
      // ci-dessus — une reclamation JAMAIS suivie d'un enfilage reussi n'est pas une tentative de
      // traitement (voir commentaire de tete de fichier : sans cela, une coupure Redis
      // transitoire ferait deraper le compteur de dead-letter).
      await options.prisma.outboxMessage.update({
        where: { id: row.id },
        data: {
          status: 'PENDING',
          lockedAt: null,
          lockedBy: null,
          attempts: { decrement: 1 },
          lastError: String(error instanceof Error ? error.message : error).slice(0, OUTBOX_MAX_ERROR_LENGTH),
        },
      });
      options.logger?.error(
        { event: 'outbox.message.enqueue-failed', outboxMessageId: row.id, eventType: row.eventType },
        "Echec d'enfilage BullMQ d'un message Outbox — remis PENDING immediatement, tentative non comptee",
      );
    }
  }

  return { claimed: claimed.length, enqueued, enqueueFailed };
}
