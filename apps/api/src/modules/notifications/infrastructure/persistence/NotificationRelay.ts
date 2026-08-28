import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { buildOutboxJobId } from '../../../../shared-kernel/infrastructure/queue/OutboxJob.js';
import type { NotificationJobData } from '../queue/NotificationJob.js';
import {
  NOTIFICATION_DEFAULT_BATCH_SIZE,
  NOTIFICATION_DEFAULT_STALE_LOCK_MINUTES,
  NOTIFICATION_MAX_ERROR_LENGTH,
} from './NotificationRetryPolicy.js';

/**
 * Relais du pipeline de livraison des notifications (ADR-0007 §6) — CALQUE de `OutboxRelay.ts`
 * (voir ce fichier pour la doctrine complete : Postgres source de verite unique, BullMQ simple
 * distributeur de charge, `attempts: 1` a l'enfilage, aucun retry BullMQ). Ne reclame QUE les
 * lignes dont `next_attempt_at` est atteint (`IS NULL OR <= now()`) — seul ecart deliberement
 * ajoute par rapport au calque Outbox (backoff explicite, absent du relais Outbox actuel).
 */

export interface NotificationRelayLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface NotificationRelayOptions {
  readonly prisma: PrismaClient;
  readonly queue: Queue<NotificationJobData>;
  readonly workerId: string;
  readonly batchSize?: number;
  readonly staleLockMinutes?: number;
  readonly logger?: NotificationRelayLogger;
}

export interface NotificationRelayRunSummary {
  readonly claimed: number;
  readonly enqueued: number;
  readonly enqueueFailed: number;
}

interface ClaimedNotificationRow {
  id: string;
  channel: string;
  attempts: number;
}

async function claimNotificationBatch(
  prisma: PrismaClient,
  params: { batchSize: number; staleLockMinutes: number; workerId: string },
): Promise<ClaimedNotificationRow[]> {
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - params.staleLockMinutes * 60_000);

  return prisma.$transaction(async (tx) => {
    return tx.$queryRaw<ClaimedNotificationRow[]>`
      UPDATE "platform"."Notification"
      SET status = 'PROCESSING'::"platform"."NotificationStatus",
          locked_at = ${now},
          locked_by = ${params.workerId},
          attempts = attempts + 1,
          updated_at = ${now}
      WHERE id IN (
        SELECT id FROM "platform"."Notification"
        WHERE (
          (status = 'PENDING'::"platform"."NotificationStatus" AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}))
          OR (status = 'PROCESSING'::"platform"."NotificationStatus" AND locked_at < ${staleLockBefore})
        )
        ORDER BY created_at ASC
        LIMIT ${params.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id,
        channel,
        attempts;
    `;
  });
}

/** Execute UN cycle de relais (voir commentaire de tete de fichier). */
export async function relayNotificationsOnce(options: NotificationRelayOptions): Promise<NotificationRelayRunSummary> {
  const batchSize = options.batchSize ?? NOTIFICATION_DEFAULT_BATCH_SIZE;
  const staleLockMinutes = options.staleLockMinutes ?? NOTIFICATION_DEFAULT_STALE_LOCK_MINUTES;

  const claimed = await claimNotificationBatch(options.prisma, {
    batchSize,
    staleLockMinutes,
    workerId: options.workerId,
  });

  let enqueued = 0;
  let enqueueFailed = 0;

  for (const row of claimed) {
    const jobData: NotificationJobData = { id: row.id };

    try {
      await options.queue.add(row.channel, jobData, {
        jobId: buildOutboxJobId(row.id, row.attempts),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      });
      enqueued += 1;
    } catch (error) {
      enqueueFailed += 1;
      await options.prisma.notification.update({
        where: { id: row.id },
        data: {
          status: 'PENDING',
          lockedAt: null,
          lockedBy: null,
          attempts: { decrement: 1 },
          updatedAt: new Date(),
          lastError: String(error instanceof Error ? error.message : error).slice(0, NOTIFICATION_MAX_ERROR_LENGTH),
        },
      });
      options.logger?.error(
        { event: 'notification.enqueue-failed', notificationId: row.id },
        "Echec d'enfilage BullMQ d'une notification — remise PENDING immediatement, tentative non comptee",
      );
    }
  }

  return { claimed: claimed.length, enqueued, enqueueFailed };
}
