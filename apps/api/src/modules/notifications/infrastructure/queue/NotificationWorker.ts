import type { ConnectionOptions } from 'bullmq';
import { Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { parseOutboxJobId } from '../../../../shared-kernel/infrastructure/queue/OutboxJob.js';
import { NotificationDeliveryError } from '../../domain/NotificationDeliveryError.js';
import { computeNextAttemptAt } from '../../domain/NotificationBackoff.js';
import { renderEmailContent, renderSmsContent } from '../../domain/NotificationTemplates.js';
import type { NotificationTemplateKind } from '../../domain/value-objects/NotificationTemplateKind.js';
import type { EmailProvider } from '../../domain/ports/EmailProvider.js';
import type { SmsProvider } from '../../domain/ports/SmsProvider.js';
import { NOTIFICATION_MAX_ATTEMPTS, NOTIFICATION_MAX_ERROR_LENGTH } from '../persistence/NotificationRetryPolicy.js';
import { NOTIFICATION_QUEUE_NAME, type NotificationJobData } from './NotificationJob.js';

export interface NotificationWorkerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface NotificationWorkerOptions {
  readonly prisma: PrismaClient;
  readonly emailProvider: EmailProvider;
  readonly smsProvider: SmsProvider;
  readonly connection: ConnectionOptions;
  /** DOIT correspondre au `workerId` passe a `relayNotificationsOnce()` — meme raisonnement que `OutboxWorker.ts`. */
  readonly workerId: string;
  readonly concurrency?: number;
  readonly logger?: NotificationWorkerLogger;
  readonly queueName?: string;
  readonly lockDuration?: number;
  readonly stalledInterval?: number;
  readonly maxStalledCount?: number;
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_LOCK_DURATION_MS = 60_000;
const DEFAULT_STALLED_INTERVAL_MS = 30_000;
const DEFAULT_MAX_STALLED_COUNT = 1;

/**
 * Worker BullMQ du pipeline de livraison des notifications (ADR-0007 §6) — CALQUE de
 * `shared-kernel/infrastructure/queue/OutboxWorker.ts` (voir ce fichier pour la doctrine complete
 * de re-lecture/re-validation Postgres avant tout effet). Meme sequence de garde :
 *   1. Parse `jobId` (`<id>#<attempts capture a la reclamation>`).
 *   2. RELIT la ligne REELLE `platform.Notification` — absente => no-op logge.
 *   3. Verifie `status === 'PROCESSING'`, `locked_by === options.workerId` ET
 *      `attempts === <attempts extrait du jobId>` — tout ecart = reclamation PERIMEE, no-op.
 *   4. Dispatch par `channel` (EMAIL -> EmailProvider, SMS -> SmsProvider), contenu RENDU depuis
 *      le gabarit ferme (`NotificationTemplates.ts`) — jamais de contenu arbitraire.
 *
 * Distinction TERMINALE vs TRANSITOIRE (ADR-0007 §5) : `NotificationDeliveryError.retryable`
 * decide FAILED (jamais retente) vs PENDING-avec-backoff/DEAD_LETTER (epuisement de
 * `NOTIFICATION_MAX_ATTEMPTS`) — jamais devinee depuis le message d'erreur.
 *
 * SECURITE (meme discipline qu'`OutboxWorker.ts`) : ni le destinataire ni le contenu rendu
 * n'apparaissent JAMAIS dans un log — uniquement `notificationId`/`channel`/`templateKind`/
 * `tenantId`. `lastError` ne porte que le message d'erreur du fournisseur (deja generique par
 * construction du port), jamais le destinataire ni le corps.
 */
export function createNotificationWorker(options: NotificationWorkerOptions): Worker<NotificationJobData> {
  return new Worker<NotificationJobData>(
    options.queueName ?? NOTIFICATION_QUEUE_NAME,
    async (job) => {
      const parsedJobId = parseOutboxJobId(job.id);
      if (parsedJobId === null) {
        options.logger?.error(
          { event: 'notification.worker.invalid-job-id', jobId: job.id, notificationId: job.data.id },
          'Job de notification avec un jobId BullMQ non exploitable — no-op.',
        );
        return;
      }
      const { outboxMessageId: notificationId, attemptsAtClaim } = parsedJobId;
      if (notificationId !== job.data.id) {
        options.logger?.error(
          { event: 'notification.worker.job-id-mismatch', jobId: job.id, dataId: job.data.id },
          'Job de notification dont le jobId et la charge divergent — no-op.',
        );
        return;
      }

      const row = await options.prisma.notification.findUnique({ where: { id: notificationId } });
      if (row === null) {
        options.logger?.error(
          { event: 'notification.worker.unknown-notification', notificationId },
          'Job referencant une ligne platform.Notification introuvable — no-op.',
        );
        return;
      }
      if (row.status !== 'PROCESSING') {
        options.logger?.info(
          { event: 'notification.worker.stale-job-skipped', notificationId, actualStatus: row.status },
          'Job de notification perime (statut deja avance) — no-op.',
        );
        return;
      }
      if (row.lockedBy !== options.workerId) {
        options.logger?.info(
          { event: 'notification.worker.foreign-lock-skipped', notificationId, lockedBy: row.lockedBy },
          'Job de notification verrouille par un relais different — no-op.',
        );
        return;
      }
      if (row.attempts !== attemptsAtClaim) {
        options.logger?.info(
          { event: 'notification.worker.superseded-generation-skipped', notificationId, attemptsAtClaim, currentAttempts: row.attempts },
          "Job de notification d'une generation de reclamation perimee — no-op.",
        );
        return;
      }

      try {
        const providerMessageId = await dispatch(options, row);
        const updated = await options.prisma.notification.updateMany({
          where: { id: notificationId, status: 'PROCESSING', lockedBy: options.workerId },
          data: {
            status: 'SENT',
            providerMessageId,
            sentAt: new Date(),
            lockedAt: null,
            lockedBy: null,
            updatedAt: new Date(),
          },
        });
        if (updated.count === 0) {
          options.logger?.info(
            { event: 'notification.worker.claim-changed-during-processing', notificationId },
            'La reclamation de cette ligne a change pendant le traitement — resultat ignore.',
          );
          return;
        }
        options.logger?.info(
          { event: 'notification.sent', notificationId, channel: row.channel, templateKind: row.templateKind, tenantId: row.tenantId },
          'Notification envoyee',
        );
      } catch (error) {
        const retryable = error instanceof NotificationDeliveryError ? error.retryable : true;
        const message = String(error instanceof Error ? error.message : error).slice(0, NOTIFICATION_MAX_ERROR_LENGTH);
        const isDead = retryable && row.attempts >= NOTIFICATION_MAX_ATTEMPTS;
        const nextStatus = !retryable ? 'FAILED' : isDead ? 'DEAD_LETTER' : 'PENDING';
        const now = new Date();

        options.logger?.error(
          {
            event: 'notification.failed',
            notificationId,
            channel: row.channel,
            templateKind: row.templateKind,
            tenantId: row.tenantId,
            attempts: row.attempts,
            retryable,
            nextStatus,
          },
          "Echec d'envoi d'une notification",
        );
        try {
          const updated = await options.prisma.notification.updateMany({
            where: { id: notificationId, status: 'PROCESSING', lockedBy: options.workerId },
            data: {
              status: nextStatus,
              lastError: message,
              lockedAt: null,
              lockedBy: null,
              updatedAt: now,
              nextAttemptAt: nextStatus === 'PENDING' ? computeNextAttemptAt(row.attempts, now) : null,
            },
          });
          if (updated.count === 0) {
            options.logger?.info(
              { event: 'notification.worker.claim-changed-during-processing', notificationId },
              "La reclamation de cette ligne a change pendant le traitement — l'echec de CE job n'est pas reporte en base.",
            );
          }
        } catch (updateError) {
          options.logger?.error(
            {
              event: 'notification.worker.postgres-update-failed',
              notificationId,
              error: updateError instanceof Error ? updateError.message : String(updateError),
            },
            "Echec de la mise a jour Postgres consecutive a un envoi en erreur.",
          );
        }
        throw error;
      }
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      autorun: false,
      lockDuration: options.lockDuration ?? DEFAULT_LOCK_DURATION_MS,
      stalledInterval: options.stalledInterval ?? DEFAULT_STALLED_INTERVAL_MS,
      maxStalledCount: options.maxStalledCount ?? DEFAULT_MAX_STALLED_COUNT,
    },
  );
}

async function dispatch(
  options: NotificationWorkerOptions,
  row: { id: string; channel: string; recipient: string; templateKind: string },
): Promise<string> {
  const templateKind = row.templateKind as NotificationTemplateKind;
  if (row.channel === 'EMAIL') {
    const { subject, body } = renderEmailContent(templateKind);
    const result = await options.emailProvider.send({ recipient: row.recipient, subject, body, idempotencyKey: row.id });
    return result.providerMessageId;
  }
  if (row.channel === 'SMS') {
    const { text } = renderSmsContent(templateKind);
    const result = await options.smsProvider.send({ recipient: row.recipient, text, idempotencyKey: row.id });
    return result.providerMessageId;
  }
  // Canal inconnu : corruption de donnees (colonne enum en base), jamais un cas metier attendu —
  // erreur DEFINITIVE (pas de retryable qui aurait un sens ici, aucune nouvelle tentative ne
  // resoudra une valeur de colonne invalide).
  throw new NotificationDeliveryError(`Canal de notification inconnu : "${row.channel}".`, false);
}
