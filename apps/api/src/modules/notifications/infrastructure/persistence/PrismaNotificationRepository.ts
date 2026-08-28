import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { Notification } from '../../domain/Notification.js';
import type { NotificationRepository } from '../../domain/ports/NotificationRepository.js';
import { NotificationId } from '../../domain/value-objects/NotificationId.js';
import type { NotificationChannel } from '../../domain/value-objects/NotificationChannel.js';
import type { NotificationStatus } from '../../domain/value-objects/NotificationStatus.js';
import type { NotificationTemplateKind } from '../../domain/value-objects/NotificationTemplateKind.js';

interface NotificationRow {
  id: string;
  tenantId: string | null;
  channel: string;
  recipient: string;
  templateKind: string;
  sourceEventId: string;
  status: string;
  attempts: number;
  lastError: string | null;
  providerMessageId: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
}

/**
 * Repository `Notification` — table `platform.Notification`, HORS RLS (ADR-0007 §6, meme regime
 * que `PrismaPaymentRepository`/`PrismaPlatformInvoiceRepository`).
 *
 * `create()` : `createMany({ skipDuplicates: true })` sur `(sourceEventId, channel, recipient)` — jamais un
 * `create()` rattrapant un P2002 (meme idiome que `PrismaSubscriptionRepository.save()` /
 * `PrismaPaymentRepository.save()`), pour les memes raisons de course concurrente. Retourne
 * `false` si la ligne existait deja (idempotence, deuxieme ligne de defense).
 *
 * Les transitions de statut (claim, succes, echec) ne passent PAS par ce repository — voir
 * `NotificationRelay.ts`/`infrastructure/queue/NotificationWorker.ts`, qui operent par `UPDATE`
 * SQL conditionnels directs sur la ligne, meme discipline que `OutboxRelay.ts`/`OutboxWorker.ts`.
 */
export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(notification: Notification): Promise<boolean> {
    const client = resolvePrismaClient(this.prisma);
    const result = await client.notification.createMany({
      data: [
        {
          id: notification.id.toString(),
          tenantId: notification.tenantId?.toString() ?? null,
          channel: notification.channel,
          recipient: notification.recipient,
          templateKind: notification.templateKind,
          sourceEventId: notification.sourceEventId,
          status: notification.status,
          attempts: notification.attempts,
          lastError: notification.lastError,
          providerMessageId: notification.providerMessageId,
          nextAttemptAt: notification.nextAttemptAt,
          createdAt: notification.createdAt,
          updatedAt: notification.updatedAt,
          sentAt: notification.sentAt,
        },
      ],
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  async findById(id: NotificationId, tenantId: TenantId): Promise<Notification | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.notification.findFirst({ where: { id: id.toString(), tenantId: tenantId.toString() } });
    return row === null ? null : this.toDomain(row);
  }

  private toDomain(row: NotificationRow): Notification {
    const id = assertValid(NotificationId.create(row.id));
    const tenantId = row.tenantId === null ? null : assertValid(TenantId.create(row.tenantId));
    return Notification.reconstitute(id, {
      tenantId,
      channel: row.channel as NotificationChannel,
      recipient: row.recipient,
      templateKind: row.templateKind as NotificationTemplateKind,
      sourceEventId: row.sourceEventId,
      status: row.status as NotificationStatus,
      attempts: row.attempts,
      lastError: row.lastError,
      providerMessageId: row.providerMessageId,
      nextAttemptAt: row.nextAttemptAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sentAt: row.sentAt,
    });
  }
}
