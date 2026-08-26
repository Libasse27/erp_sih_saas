import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { createOutboxQueueConnection } from '../../../src/shared-kernel/infrastructure/queue/OutboxQueueConnection.js';
import type { OutboxJobData } from '../../../src/shared-kernel/infrastructure/queue/OutboxJob.js';

/** Client Prisma connecte via le role applicatif (`sih_app`) — meme role que les autres suites d'integration (test/payment, test/subscription...). */
export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient();
}

/** Client PostgreSQL brut — insertions directes de lignes `OutboxMessage` "au passe" (locked_at perime) que le domaine ne permet pas de construire autrement, et nettoyage post-test. */
export async function createRawPgClient(): Promise<PgClient> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

export function uniqueId(): string {
  return randomUUID();
}

/**
 * File BullMQ ISOLEE par test (nom aleatoire) — jamais la file de production `OUTBOX_QUEUE_NAME`
 * partagee entre suites de test paralleles (§9.2 du system prompt : "aucune base partagee entre
 * fichiers"). Retourne aussi la connexion Redis dediee (a fermer explicitement en `afterAll`, voir
 * `closeTestOutboxQueue`).
 */
export function createTestOutboxQueue(): { queueName: string; connection: Redis; queue: Queue<OutboxJobData> } {
  const queueName = `test-outbox-${randomUUID()}`;
  const connection = createOutboxQueueConnection(requireRedisUrl());
  const queue = new Queue<OutboxJobData>(queueName, { connection });
  return { queueName, connection, queue };
}

export async function closeTestOutboxQueue(handle: { connection: Redis; queue: Queue<OutboxJobData> }): Promise<void> {
  await handle.queue.obliterate({ force: true }).catch(() => undefined);
  await handle.queue.close();
  await handle.connection.quit();
}

export async function closeTestOutboxWorker(worker: Worker<OutboxJobData>): Promise<void> {
  await worker.close();
}

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (url === undefined) {
    throw new Error('REDIS_URL manquant pour les tests d_integration.');
  }
  return url;
}
