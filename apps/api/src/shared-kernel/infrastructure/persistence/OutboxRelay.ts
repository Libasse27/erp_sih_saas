import type { PrismaClient } from '@prisma/client';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../application/OutboxEventHandler.js';

export type { OutboxEventEnvelope, OutboxEventHandler };

/**
 * Relais Outbox — lit les messages `platform.OutboxMessage` non traites et les distribue aux
 * handlers enregistres par type d'evenement (D9, 01-target-architecture.md §9.3 : "puis relaye
 * par un worker... garantie at-least-once -> tout consommateur est idempotent").
 *
 * DECISION D'IMPLEMENTATION (etape 5, a documenter/valider) : polling periodique en base avec
 * verrouillage optimiste (`FOR UPDATE SKIP LOCKED`), PAS BullMQ. Justification :
 *   1. `bullmq` n'est PAS une dependance declaree du projet (seul `ioredis` l'est, pour
 *      sessions/cache) — l'ajouter pour cette seule etape aurait ete une dependance lourde non
 *      strictement necessaire au perimetre demande.
 *   2. Le volume attendu (evenements SaaS : abonnements, paiements de quelques centaines
 *      d'etablissements) ne justifie pas une file de messages dediee ; `SKIP LOCKED` offre deja
 *      une distribution sure entre plusieurs workers concurrents sans double-traitement bloquant.
 *   3. Cela reste strictement conforme au contrat D9 (meme transaction que l'agregat, relais
 *      asynchrone, at-least-once, consommateurs idempotents) : le contrat ne prescrit pas
 *      BullMQ, seulement ces proprietes.
 * Si le volume ou le besoin de fonctionnalites avancees (delais programmes, DLQ visuelle,
 * priorites) grandit, une migration vers BullMQ reste possible sans changer le contrat
 * `OutboxEventHandler` ci-dessous — c'est un point a ouvrir avec l'architecte si le besoin se
 * confirme, pas une decision d'architecture actee ici.
 */

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_STALE_LOCK_MINUTES = 5;
const MAX_ATTEMPTS = 8;
const MAX_ERROR_LENGTH = 2000;

export interface OutboxRelayLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface OutboxRelayOptions {
  readonly prisma: PrismaClient;
  /** Table de dispatch : type d'evenement -> handlers enregistres (0..N). Cablee UNIQUEMENT dans composition-root.ts (seul point autorise a connaitre plusieurs modules). */
  readonly handlers: ReadonlyMap<string, readonly OutboxEventHandler[]>;
  readonly workerId: string;
  readonly batchSize?: number;
  readonly staleLockMinutes?: number;
  readonly logger?: OutboxRelayLogger;
}

export interface OutboxRelayRunSummary {
  readonly claimed: number;
  readonly processed: number;
  readonly failed: number;
  readonly deadLettered: number;
}

interface ClaimedOutboxRow {
  id: string;
  eventType: string;
  eventVersion: number;
  aggregateId: string;
  tenantId: string | null;
  occurredAt: Date;
  payload: unknown;
  attempts: number;
}

/**
 * Execute UN cycle de relais : reclame un lot de messages `PENDING` (ou `PROCESSING` depuis trop
 * longtemps — recuperation apres crash d'un worker), les distribue, marque chacun `PROCESSED` ou
 * le remet en file (`PENDING`, avec `lastError`) jusqu'a `MAX_ATTEMPTS`, au-dela duquel il passe
 * `FAILED` (file morte — nécessite une intervention/reprise manuelle, jamais silencieusement
 * perdu).
 *
 * `FOR UPDATE SKIP LOCKED` permet a plusieurs workers de tourner en parallele sans se bloquer ni
 * se doubler : chacun ne reclame que des lignes que personne d'autre n'a deja verrouillees.
 */
export async function relayOutboxOnce(options: OutboxRelayOptions): Promise<OutboxRelayRunSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const staleLockMinutes = options.staleLockMinutes ?? DEFAULT_STALE_LOCK_MINUTES;
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - staleLockMinutes * 60_000);

  const claimed = await options.prisma.$transaction(async (tx) => {
    return tx.$queryRaw<ClaimedOutboxRow[]>`
      UPDATE "platform"."OutboxMessage"
      SET status = 'PROCESSING'::"platform"."OutboxMessageStatus",
          locked_at = ${now},
          locked_by = ${options.workerId},
          attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM "platform"."OutboxMessage"
        WHERE status = 'PENDING'::"platform"."OutboxMessageStatus"
           OR (status = 'PROCESSING'::"platform"."OutboxMessageStatus" AND locked_at < ${staleLockBefore})
        ORDER BY occurred_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id,
        event_type AS "eventType",
        event_version AS "eventVersion",
        aggregate_id AS "aggregateId",
        tenant_id AS "tenantId",
        occurred_at AS "occurredAt",
        payload,
        attempts;
    `;
  });

  let processed = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const row of claimed) {
    const envelope: OutboxEventEnvelope = {
      id: row.id,
      eventType: row.eventType,
      eventVersion: row.eventVersion,
      aggregateId: row.aggregateId,
      tenantId: row.tenantId,
      occurredAt: row.occurredAt,
      payload: row.payload,
    };
    const handlers = options.handlers.get(row.eventType) ?? [];

    try {
      for (const handler of handlers) {
        await handler(envelope);
      }
      await options.prisma.outboxMessage.update({
        where: { id: row.id },
        data: { status: 'PROCESSED', processedAt: new Date(), lockedAt: null, lockedBy: null },
      });
      processed += 1;
      options.logger?.info(
        { event: 'outbox.message.processed', outboxMessageId: row.id, eventType: row.eventType, tenantId: row.tenantId, handlerCount: handlers.length },
        'Message Outbox traite',
      );
    } catch (error) {
      const isDead = row.attempts >= MAX_ATTEMPTS;
      await options.prisma.outboxMessage.update({
        where: { id: row.id },
        data: {
          status: isDead ? 'FAILED' : 'PENDING',
          lastError: String(error instanceof Error ? error.message : error).slice(0, MAX_ERROR_LENGTH),
          lockedAt: null,
          lockedBy: null,
        },
      });
      failed += 1;
      if (isDead) {
        deadLettered += 1;
      }
      options.logger?.error(
        {
          event: 'outbox.message.failed',
          outboxMessageId: row.id,
          eventType: row.eventType,
          tenantId: row.tenantId,
          attempts: row.attempts,
          deadLettered: isDead,
        },
        'Echec de traitement d_un message Outbox',
      );
    }
  }

  return { claimed: claimed.length, processed, failed, deadLettered };
}
