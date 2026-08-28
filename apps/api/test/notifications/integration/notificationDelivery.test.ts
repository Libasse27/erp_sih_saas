import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { relayNotificationsOnce } from '../../../src/modules/notifications/infrastructure/persistence/NotificationRelay.js';
import { NOTIFICATION_MAX_ATTEMPTS } from '../../../src/modules/notifications/infrastructure/persistence/NotificationRetryPolicy.js';
import { createNotificationWorker } from '../../../src/modules/notifications/infrastructure/queue/NotificationWorker.js';
import { buildOutboxJobId } from '../../../src/shared-kernel/infrastructure/queue/OutboxJob.js';
import type { NotificationJobData } from '../../../src/modules/notifications/infrastructure/queue/NotificationJob.js';
import { SandboxEmailProviderAdapter } from '../../../src/modules/notifications/infrastructure/providers/SandboxEmailProviderAdapter.js';
import { SandboxSmsProviderAdapter } from '../../../src/modules/notifications/infrastructure/providers/SandboxSmsProviderAdapter.js';
import { PrismaNotificationRepository } from '../../../src/modules/notifications/infrastructure/persistence/PrismaNotificationRepository.js';
import { NotificationId } from '../../../src/modules/notifications/domain/value-objects/NotificationId.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import {
  closeTestNotificationQueue,
  closeTestNotificationWorker,
  createRawPgClient,
  createTestNotificationQueue,
  createTestPrismaClient,
  uniqueId,
} from './dbTestHelpers.js';

/**
 * Adversarial — pipeline de livraison des notifications (ADR-0007 §6, etape 9/13). Postgres reel
 * (`platform.Notification`) + Redis reel (BullMQ) : necessite `docker compose up -d` et les
 * migrations appliquees. AUCUN mock — meme discipline que test/shared-kernel/integration/
 * outboxRelay.test.ts (dont ce fichier reprend la structure et les scenarios adversariaux).
 */
describe('NotificationRelay + NotificationWorker — reprise apres crash, dead-letter, backoff, securite (adversarial)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let insertedIds: string[] = [];
  let activeWorkers: Worker<NotificationJobData>[] = [];
  let activeQueues: { queue: Queue<NotificationJobData>; connection: Redis }[] = [];

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
  });

  afterEach(async () => {
    await Promise.all(activeWorkers.map((worker) => closeTestNotificationWorker(worker)));
    activeWorkers = [];
    await Promise.all(activeQueues.map((handle) => closeTestNotificationQueue(handle)));
    activeQueues = [];
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await rawClient.query('DELETE FROM "platform"."Notification" WHERE id = ANY($1)', [insertedIds]);
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  async function insertNotificationRow(params: {
    id: string;
    channel?: 'EMAIL' | 'SMS';
    recipient?: string;
    templateKind?: 'SUBSCRIPTION_WELCOME' | 'SUBSCRIPTION_PLAN_CHANGED';
    sourceEventId?: string;
    status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'DEAD_LETTER';
    attempts: number;
    tenantId?: string | null;
    lockedAt?: Date | null;
    lockedBy?: string | null;
    nextAttemptAt?: Date | null;
  }): Promise<void> {
    insertedIds.push(params.id);
    const now = new Date();
    await rawClient.query(
      `INSERT INTO "platform"."Notification"
         (id, tenant_id, channel, recipient, template_kind, source_event_id, status, attempts, locked_at, locked_by, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3::"platform"."NotificationChannel", $4, $5::"platform"."NotificationTemplateKind", $6, $7::"platform"."NotificationStatus", $8, $9, $10, $11, $12, $13)`,
      [
        params.id,
        params.tenantId ?? null,
        params.channel ?? 'EMAIL',
        params.recipient ?? 'admin@hopital.sn',
        params.templateKind ?? 'SUBSCRIPTION_WELCOME',
        params.sourceEventId ?? uniqueId(),
        params.status,
        params.attempts,
        params.lockedAt ?? null,
        params.lockedBy ?? null,
        params.nextAttemptAt ?? null,
        now,
        now,
      ],
    );
  }

  async function readNotificationRow(
    id: string,
  ): Promise<{ status: string; attempts: number; lockedBy: string | null; lastError: string | null; providerMessageId: string | null; nextAttemptAt: Date | null }> {
    const result = await rawClient.query(
      `SELECT status, attempts, locked_by AS "lockedBy", last_error AS "lastError", provider_message_id AS "providerMessageId", next_attempt_at AS "nextAttemptAt"
       FROM "platform"."Notification" WHERE id = $1`,
      [id],
    );
    return result.rows[0] as {
      status: string;
      attempts: number;
      lockedBy: string | null;
      lastError: string | null;
      providerMessageId: string | null;
      nextAttemptAt: Date | null;
    };
  }

  /** Meme raisonnement que outboxRelay.test.ts : la table est PARTAGEE par toute la suite de tests, filtrer sur le prefixe du jobId (identifiant + generation), jamais "le premier evenement recu". */
  function waitForJobOutcome(worker: Worker<NotificationJobData>, notificationId: string): Promise<'completed' | 'failed'> {
    const prefix = `${notificationId}#`;
    return new Promise((resolve) => {
      worker.on('completed', (job) => {
        if (job.id?.startsWith(prefix) === true) resolve('completed');
      });
      worker.on('failed', (job) => {
        if (job?.id?.startsWith(prefix) === true) resolve('failed');
      });
    });
  }

  async function waitUntilJobActive(queue: Queue<NotificationJobData>, jobId: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const job = await queue.getJob(jobId);
      if (job !== undefined && (await job.isActive())) {
        return;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Job ${jobId} jamais devenu actif avant ${timeoutMs}ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const GENEROUS_BATCH_SIZE = 1000;

  function buildProviders(): { emailProvider: SandboxEmailProviderAdapter; smsProvider: SandboxSmsProviderAdapter } {
    return { emailProvider: new SandboxEmailProviderAdapter(), smsProvider: new SandboxSmsProviderAdapter() };
  }

  it('reclame une notification PROCESSING dont le verrou est perime (crash d_un worker precedent) et l_envoie', async () => {
    const id = uniqueId();
    const workerId = `test-worker-${uniqueId()}`;
    await insertNotificationRow({
      id,
      status: 'PROCESSING',
      attempts: 1,
      lockedAt: new Date(Date.now() - 10 * 60_000),
      lockedBy: 'dead-worker-1',
    });

    const { queue, connection } = createTestNotificationQueue();
    activeQueues.push({ queue, connection });
    const { emailProvider, smsProvider } = buildProviders();
    const worker = createNotificationWorker({ prisma, emailProvider, smsProvider, connection, queueName: queue.name, workerId });
    activeWorkers.push(worker);
    const outcome = waitForJobOutcome(worker, id);
    void worker.run();

    const summary = await relayNotificationsOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });
    expect(summary.claimed).toBeGreaterThanOrEqual(1);

    await expect(outcome).resolves.toBe('completed');
    const row = await readNotificationRow(id);
    expect(row.status).toBe('SENT');
    expect(row.attempts).toBe(2);
    expect(row.providerMessageId).toMatch(/^sandbox-email-/);
    // Compte GLOBAL, pas exclusif : `relayNotificationsOnce` reclame sans filtrer par file, donc un
    // GENEROUS_BATCH_SIZE partage `platform.Notification` avec d'autres suites de test executees en
    // parallele peut faire transiter des lignes etrangeres par CE worker. Seule la presence de NOTRE
    // notification (cle d'idempotence = son id) est une assertion fiable ici.
    expect(emailProvider.sentMessages().some((message) => message.idempotencyKey === id)).toBe(true);
  });

  it('at-least-once : un echec TRANSITOIRE puis un succes finit par envoyer, sans perte de la notification', async () => {
    const id = uniqueId();
    const workerId = `test-worker-${uniqueId()}`;
    await insertNotificationRow({ id, status: 'PENDING', attempts: 0 });

    const { emailProvider, smsProvider } = buildProviders();
    emailProvider.queueFailure({ retryable: true, message: 'SMTP timeout (simule).' });
    const { queue, connection } = createTestNotificationQueue();
    activeQueues.push({ queue, connection });
    const worker = createNotificationWorker({ prisma, emailProvider, smsProvider, connection, queueName: queue.name, workerId });
    activeWorkers.push(worker);

    let outcome = waitForJobOutcome(worker, id);
    void worker.run();
    await relayNotificationsOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });
    await expect(outcome).resolves.toBe('failed');
    let row = await readNotificationRow(id);
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).not.toBeNull(); // backoff programme, voir test dedie ci-dessous
    expect(row.lastError).toContain('SMTP timeout');

    // Reclamation immediate ignoree tant que le backoff n'est pas ecoule (voir test "respecte le
    // backoff" plus bas pour la preuve isolee) — on force ici `next_attempt_at` dans le passe pour
    // ne PAS coupler ce test au delai reel.
    await rawClient.query('UPDATE "platform"."Notification" SET next_attempt_at = NULL WHERE id = $1', [id]);

    outcome = waitForJobOutcome(worker, id);
    await relayNotificationsOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });
    await expect(outcome).resolves.toBe('completed');
    row = await readNotificationRow(id);
    expect(row.status).toBe('SENT');
    expect(row.attempts).toBe(2);
  });

  it('passe en DEAD_LETTER (jamais un simple FAILED) des que NOTIFICATION_MAX_ATTEMPTS est atteint sur des echecs TRANSITOIRES', async () => {
    const id = uniqueId();
    const workerId = `test-worker-${uniqueId()}`;
    await insertNotificationRow({ id, status: 'PENDING', attempts: NOTIFICATION_MAX_ATTEMPTS - 1 });

    const { emailProvider, smsProvider } = buildProviders();
    emailProvider.queueFailure({ retryable: true, message: 'Panne fournisseur persistante (simulee).' });
    const { queue, connection } = createTestNotificationQueue();
    activeQueues.push({ queue, connection });
    const worker = createNotificationWorker({ prisma, emailProvider, smsProvider, connection, queueName: queue.name, workerId });
    activeWorkers.push(worker);
    const outcome = waitForJobOutcome(worker, id);
    void worker.run();

    await relayNotificationsOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });
    await expect(outcome).resolves.toBe('failed');

    const row = await readNotificationRow(id);
    expect(row.status).toBe('DEAD_LETTER');
    expect(row.attempts).toBe(NOTIFICATION_MAX_ATTEMPTS);
  });

  it('passe en FAILED IMMEDIATEMENT (jamais retentee) sur une erreur DEFINITIVE — distinction retryable, ADR-0007 §5', async () => {
    const id = uniqueId();
    const workerId = `test-worker-${uniqueId()}`;
    await insertNotificationRow({ id, status: 'PENDING', attempts: 0 });

    const { emailProvider, smsProvider } = buildProviders();
    emailProvider.queueFailure({ retryable: false, message: 'Destinataire rejete definitivement (simule).' });
    const { queue, connection } = createTestNotificationQueue();
    activeQueues.push({ queue, connection });
    const worker = createNotificationWorker({ prisma, emailProvider, smsProvider, connection, queueName: queue.name, workerId });
    activeWorkers.push(worker);
    const outcome = waitForJobOutcome(worker, id);
    void worker.run();

    await relayNotificationsOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });
    await expect(outcome).resolves.toBe('failed');

    const row = await readNotificationRow(id);
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1); // une SEULE tentative — jamais retentee malgre un budget de tentatives disponible
    expect(row.nextAttemptAt).toBeNull();
  });

  it("un job BullMQ forge (id absent de platform.Notification) est un no-op silencieux, jamais un envoi — Redis n_est pas une frontiere de confiance", async () => {
    const forgedId = uniqueId();
    const workerId = `test-worker-${uniqueId()}`;
    const { emailProvider, smsProvider } = buildProviders();
    const { queue, connection } = createTestNotificationQueue();
    activeQueues.push({ queue, connection });
    const worker = createNotificationWorker({ prisma, emailProvider, smsProvider, connection, queueName: queue.name, workerId });
    activeWorkers.push(worker);
    const outcome = waitForJobOutcome(worker, forgedId);
    void worker.run();

    await queue.add('EMAIL', { id: forgedId }, {
      jobId: buildOutboxJobId(forgedId, 0),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });

    await expect(outcome).resolves.toBe('completed');
    expect(emailProvider.sentMessages()).toHaveLength(0);
  });

  it("le job Redis ne porte QUE l_identifiant de la ligne — jamais le destinataire ni le contenu (minimisation, exigence explicite)", async () => {
    const id = uniqueId();
    const workerId = `test-worker-${uniqueId()}`;
    await insertNotificationRow({ id, status: 'PENDING', attempts: 0, recipient: 'secret-recipient@hopital.sn' });

    const { queue, connection } = createTestNotificationQueue();
    activeQueues.push({ queue, connection });
    await relayNotificationsOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });

    const jobId = buildOutboxJobId(id, 1);
    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(Object.keys(job?.data ?? {})).toEqual(['id']);
    expect(JSON.stringify(job?.data)).not.toContain('secret-recipient');
  });

  it('respecte le backoff : une notification PENDING dont next_attempt_at est dans le futur n_est PAS reclamee avant l_echeance', async () => {
    const id = uniqueId();
    const workerId = `test-worker-${uniqueId()}`;
    await insertNotificationRow({
      id,
      status: 'PENDING',
      attempts: 1,
      nextAttemptAt: new Date(Date.now() + 60_000), // 1 minute dans le futur
    });

    const { queue, connection } = createTestNotificationQueue();
    activeQueues.push({ queue, connection });
    const summary = await relayNotificationsOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });

    const row = await readNotificationRow(id);
    expect(row.status).toBe('PENDING'); // pas reclamee : toujours PENDING, jamais passee PROCESSING
    expect(row.attempts).toBe(1); // inchange
    void summary;
  });

  it(
    'un job dont le worker est tue en cours de traitement est redistribue par le mecanisme "stalled" de BullMQ, bien avant le delai de reprise Postgres',
    async () => {
      const id = uniqueId();
      const workerId = `test-worker-${uniqueId()}`;
      await insertNotificationRow({ id, status: 'PENDING', attempts: 0 });

      const { queue, connection } = createTestNotificationQueue();
      activeQueues.push({ queue, connection });
      await relayNotificationsOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });

      const smallTimings = { lockDuration: 300, stalledInterval: 300, maxStalledCount: 1 };
      const { emailProvider: emailA, smsProvider: smsA } = buildProviders();
      const workerA = createNotificationWorker({
        prisma,
        emailProvider: { send: async () => new Promise(() => {}) },
        smsProvider: smsA,
        connection,
        queueName: queue.name,
        workerId,
        ...smallTimings,
      });
      void emailA;
      activeWorkers.push(workerA);
      void workerA.run();

      const jobId = buildOutboxJobId(id, 1);
      await waitUntilJobActive(queue, jobId);
      await workerA.close(true);

      const { emailProvider: emailB, smsProvider: smsB } = buildProviders();
      const workerB = createNotificationWorker({
        prisma,
        emailProvider: emailB,
        smsProvider: smsB,
        connection,
        queueName: queue.name,
        workerId,
        ...smallTimings,
      });
      activeWorkers.push(workerB);

      const startedWaitingAt = Date.now();
      const outcome = waitForJobOutcome(workerB, id);
      void workerB.run();

      await expect(outcome).resolves.toBe('completed');
      expect(Date.now() - startedWaitingAt).toBeLessThan(10_000);

      const row = await readNotificationRow(id);
      expect(row.status).toBe('SENT');
      // Compte GLOBAL, pas exclusif — voir le commentaire equivalent du test "reclame une
      // notification PROCESSING..." plus haut (GENEROUS_BATCH_SIZE partage la table entre suites).
      expect(emailB.sentMessages().some((message) => message.idempotencyKey === id)).toBe(true);
    },
    20_000,
  );

  it('contrainte UNIQUE (source_event_id, channel, recipient) : deux notifications pour le meme evenement/canal/destinataire ne peuvent pas coexister', async () => {
    const sourceEventId = uniqueId();
    const idA = uniqueId();
    const idB = uniqueId();
    await insertNotificationRow({ id: idA, status: 'PENDING', attempts: 0, sourceEventId, recipient: 'admin@hopital.sn' });

    await expect(
      insertNotificationRow({ id: idB, status: 'PENDING', attempts: 0, sourceEventId, recipient: 'admin@hopital.sn' }),
    ).rejects.toThrow();
  });

  it('deux destinataires DIFFERENTS pour le MEME evenement/canal coexistent normalement (pas une reutilisation abusive de la cle d_idempotence)', async () => {
    const sourceEventId = uniqueId();
    const idA = uniqueId();
    const idB = uniqueId();
    await insertNotificationRow({ id: idA, status: 'PENDING', attempts: 0, sourceEventId, recipient: 'admin1@hopital.sn' });
    await expect(
      insertNotificationRow({ id: idB, status: 'PENDING', attempts: 0, sourceEventId, recipient: 'admin2@hopital.sn' }),
    ).resolves.toBeUndefined();
  });

  it("findById exige le tenantId de l_appelant — un id seul (meme non devinable) ne suffit jamais a lire la ligne d_un AUTRE tenant (revue de securite etape 9/13, F1)", async () => {
    const id = uniqueId();
    const ownerTenantId = uniqueId();
    const otherTenantId = uniqueId();
    await insertNotificationRow({ id, status: 'PENDING', attempts: 0, tenantId: ownerTenantId });

    const repository = new PrismaNotificationRepository(prisma);
    const notificationId = NotificationId.create(id);
    if (notificationId.isFailure()) {
      throw new Error('NotificationId invalide dans le test.');
    }
    const ownerTenantIdVo = TenantId.create(ownerTenantId);
    const otherTenantIdVo = TenantId.create(otherTenantId);
    if (ownerTenantIdVo.isFailure() || otherTenantIdVo.isFailure()) {
      throw new Error('TenantId invalide dans le test.');
    }

    const foundByOwner = await repository.findById(notificationId.getValue(), ownerTenantIdVo.getValue());
    expect(foundByOwner).not.toBeNull();
    expect(foundByOwner?.id.toString()).toBe(id);

    const foundByOther = await repository.findById(notificationId.getValue(), otherTenantIdVo.getValue());
    expect(foundByOther).toBeNull();
  });
});
