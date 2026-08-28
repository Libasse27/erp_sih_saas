import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { createOutboxQueueConnection } from '../../../src/shared-kernel/infrastructure/queue/OutboxQueueConnection.js';
import type { NotificationJobData } from '../../../src/modules/notifications/infrastructure/queue/NotificationJob.js';

/** Calque de test/shared-kernel/integration/dbTestHelpers.ts — voir ce fichier pour le raisonnement complet. */
export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient();
}

export async function createRawPgClient(): Promise<PgClient> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

export function uniqueId(): string {
  return randomUUID();
}

/** File BullMQ ISOLEE par test (nom aleatoire) — jamais `NOTIFICATION_QUEUE_NAME` de production partagee entre suites de test paralleles. */
export function createTestNotificationQueue(): { queueName: string; connection: Redis; queue: Queue<NotificationJobData> } {
  const queueName = `test-notification-delivery-${randomUUID()}`;
  const connection = createOutboxQueueConnection(requireRedisUrl());
  const queue = new Queue<NotificationJobData>(queueName, { connection });
  return { queueName, connection, queue };
}

export async function closeTestNotificationQueue(handle: { connection: Redis; queue: Queue<NotificationJobData> }): Promise<void> {
  await handle.queue.obliterate({ force: true }).catch(() => undefined);
  await handle.queue.close();
  await handle.connection.quit();
}

export async function closeTestNotificationWorker(worker: Worker<NotificationJobData>): Promise<void> {
  await worker.close();
}

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined) {
    throw new Error('REDIS_URL manquant pour les tests d_integration.');
  }
  return url;
}
