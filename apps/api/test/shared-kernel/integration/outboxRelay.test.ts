import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OutboxEventHandler } from '../../../src/shared-kernel/application/OutboxEventHandler.js';
import { relayOutboxOnce } from '../../../src/shared-kernel/infrastructure/persistence/OutboxRelay.js';
import { OUTBOX_MAX_ATTEMPTS } from '../../../src/shared-kernel/infrastructure/persistence/OutboxRetryPolicy.js';
import { createOutboxWorker } from '../../../src/shared-kernel/infrastructure/queue/OutboxWorker.js';
import { buildOutboxJobId, type OutboxJobData } from '../../../src/shared-kernel/infrastructure/queue/OutboxJob.js';
import {
  closeTestOutboxQueue,
  closeTestOutboxWorker,
  createRawPgClient,
  createTestOutboxQueue,
  createTestPrismaClient,
  uniqueId,
} from './dbTestHelpers.js';

/**
 * Adversarial — relais Outbox migre vers BullMQ (ADR-0004, etape 6/13). Postgres reel
 * (`OutboxMessage`) + Redis reel (BullMQ) : necessite `docker compose up -d` et les migrations
 * appliquees. AUCUN mock — memes conventions que test/payment/integration,
 * test/subscription/integration.
 *
 * Chaque test construit sa PROPRE file BullMQ isolee (`createTestOutboxQueue`, nom aleatoire) ET
 * son propre `workerId` (jamais partage entre tests) : jamais la file/l'identite de production
 * partagee entre suites paralleles.
 */
describe('OutboxRelay + OutboxWorker — reprise apres crash, dead-letter, at-least-once, securite (adversarial)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let insertedIds: string[] = [];
  let activeWorkers: Worker<OutboxJobData>[] = [];
  let activeQueues: { queue: Queue<OutboxJobData>; connection: Redis }[] = [];

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
  });

  afterEach(async () => {
    await Promise.all(activeWorkers.map((worker) => closeTestOutboxWorker(worker)));
    activeWorkers = [];
    await Promise.all(activeQueues.map((handle) => closeTestOutboxQueue(handle)));
    activeQueues = [];
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await rawClient.query('DELETE FROM "platform"."OutboxMessage" WHERE id = ANY($1)', [insertedIds]);
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  async function insertOutboxRow(params: {
    id: string;
    eventType: string;
    status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED';
    attempts: number;
    tenantId?: string | null;
    payload?: unknown;
    occurredAt?: Date;
    lockedAt?: Date | null;
    lockedBy?: string | null;
  }): Promise<void> {
    insertedIds.push(params.id);
    // NB : `aggregate_id` recoit une DEUXIEME occurrence explicite de `params.id` ($3), jamais une
    // reutilisation de $1 (Postgres inffererait deux types distincts pour le meme numero de
    // parametre — voir la meme note dans outboxIdempotency.test.ts).
    await rawClient.query(
      `INSERT INTO "platform"."OutboxMessage"
         (id, event_type, event_version, aggregate_id, tenant_id, payload, status, occurred_at, attempts, locked_at, locked_by)
       VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        params.id,
        params.eventType,
        params.id,
        params.tenantId ?? null,
        JSON.stringify(params.payload ?? { marker: params.id }),
        params.status,
        params.occurredAt ?? new Date(),
        params.attempts,
        params.lockedAt ?? null,
        params.lockedBy ?? null,
      ],
    );
  }

  async function readOutboxRow(id: string): Promise<{ status: string; attempts: number; lockedBy: string | null }> {
    const result = await rawClient.query(
      'SELECT status, attempts, locked_by AS "lockedBy" FROM "platform"."OutboxMessage" WHERE id = $1',
      [id],
    );
    return result.rows[0] as { status: string; attempts: number; lockedBy: string | null };
  }

  /**
   * Filtre EXPLICITEMENT sur l'identifiant du MESSAGE (prefixe du `jobId` BullMQ, qui porte aussi
   * la generation de tentative — voir `buildOutboxJobId`), jamais sur "le premier evenement
   * complete/failed recu" : la table `platform.OutboxMessage` est un registre PARTAGE par toute la
   * suite de tests d'integration (Identity/Tenant/Subscription/Payment y ecrivent aussi de vrais
   * evenements, jamais nettoyes par ces suites), donc un `relayOutboxOnce` avec un `batchSize`
   * large peut enfiler et faire completer/echouer des jobs SANS RAPPORT avec CE test dans le MEME
   * worker.
   */
  function waitForJobOutcome(worker: Worker<OutboxJobData>, outboxMessageId: string): Promise<'completed' | 'failed'> {
    // Separateur `#` (voir buildOutboxJobId/OutboxJob.ts) — jamais `:`, que BullMQ rejette pour
    // un jobId personnalise (voir le commentaire de tete de OutboxJob.ts).
    const prefix = `${outboxMessageId}#`;
    return new Promise((resolve) => {
      worker.on('completed', (job) => {
        if (job.id?.startsWith(prefix) === true) resolve('completed');
      });
      worker.on('failed', (job) => {
        if (job?.id?.startsWith(prefix) === true) resolve('failed');
      });
    });
  }

  async function waitUntilJobActive(queue: Queue<OutboxJobData>, jobId: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const job = await queue.getJob(jobId);
      if (job !== undefined && (await job.isActive())) {
        return;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Job ${jobId} jamais devenu actif avant ${timeoutMs}ms (environnement lent, ou regression).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // Batch large : la reclamation SQL (`ORDER BY occurred_at ASC LIMIT batchSize`) doit couvrir
  // NOTRE ligne meme en presence de nombreuses lignes `PENDING` plus anciennes laissees par
  // d'autres suites de test (voir commentaire de `waitForJobOutcome` ci-dessus) — sans cela, une
  // ligne fraichement inseree pourrait ne jamais entrer dans un petit lot faute de tourner assez
  // de cycles.
  const GENEROUS_BATCH_SIZE = 1000;

  it('reclame un message PROCESSING dont le verrou est perime (crash d_un worker precedent) et le traite jusqu_au bout', async () => {
    const id = uniqueId();
    const workerId = `test-worker-${uniqueId()}`;
    await insertOutboxRow({
      id,
      eventType: 'shared-kernel-test.crash-recovery',
      status: 'PROCESSING',
      attempts: 1,
      lockedAt: new Date(Date.now() - 10 * 60_000), // 10 minutes dans le passe : perime (defaut 5 min)
      lockedBy: 'dead-worker-1',
    });

    const { queue, connection } = createTestOutboxQueue();
    activeQueues.push({ queue, connection });
    const handlers = new Map<string, readonly OutboxEventHandler[]>();
    const worker = createOutboxWorker({ prisma, handlers, connection, queueName: queue.name, workerId });
    activeWorkers.push(worker);
    const outcome = waitForJobOutcome(worker, id);
    void worker.run();

    const summary = await relayOutboxOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });
    // Au moins NOTRE ligne (potentiellement d'autres, voir commentaire ci-dessus) — jamais une
    // egalite stricte sur une table partagee par toute la suite de test.
    expect(summary.claimed).toBeGreaterThanOrEqual(1);
    expect(summary.enqueued).toBeGreaterThanOrEqual(1);

    await expect(outcome).resolves.toBe('completed');
    const row = await readOutboxRow(id);
    expect(row.status).toBe('PROCESSED');
    // Incremente UNE fois par la reclamation (etait a 1, le "crash" precedent l'avait deja
    // incremente une premiere fois) — preuve que la ligne a bien ete RE-reclamee, pas ignoree.
    expect(row.attempts).toBe(2);
  });

  it('at-least-once : un handler qui echoue une premiere fois puis reussit finit par etre traite avec succes, sans perte du message', async () => {
    const id = uniqueId();
    const workerId = `test-worker-${uniqueId()}`;
    await insertOutboxRow({ id, eventType: 'shared-kernel-test.at-least-once', status: 'PENDING', attempts: 0 });

    let callCount = 0;
    const handler: OutboxEventHandler = async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('Echec transitoire simule (premiere tentative).');
      }
    };
    const handlers = new Map<string, readonly OutboxEventHandler[]>([
      ['shared-kernel-test.at-least-once', [handler]],
    ]);

    const { queue, connection } = createTestOutboxQueue();
    activeQueues.push({ queue, connection });
    const worker = createOutboxWorker({ prisma, handlers, connection, queueName: queue.name, workerId });
    activeWorkers.push(worker);

    // Cycle 1 : le handler echoue -> le message doit rester exploitable (remis PENDING), jamais perdu.
    let outcome = waitForJobOutcome(worker, id);
    void worker.run();
    await relayOutboxOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });
    await expect(outcome).resolves.toBe('failed');
    let row = await readOutboxRow(id);
    expect(row.status).toBe('PENDING');
    expect(callCount).toBe(1);

    // Cycle 2 : re-livraison (at-least-once) -> le handler reussit cette fois -> PROCESSED.
    outcome = waitForJobOutcome(worker, id);
    await relayOutboxOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });
    await expect(outcome).resolves.toBe('completed');
    row = await readOutboxRow(id);
    expect(row.status).toBe('PROCESSED');
    expect(callCount).toBe(2);
  });

  it('passe en FAILED (dead-letter) des que le nombre maximal de tentatives est atteint', async () => {
    const id = uniqueId();
    const workerId = `test-worker-${uniqueId()}`;
    // attempts = MAX_ATTEMPTS - 1 : le PROCHAIN cycle de reclamation l_incremente a MAX_ATTEMPTS,
    // exactement le seuil de dead-letter verifie par OutboxWorker.ts.
    await insertOutboxRow({ id, eventType: 'shared-kernel-test.dead-letter', status: 'PENDING', attempts: OUTBOX_MAX_ATTEMPTS - 1 });

    const handler: OutboxEventHandler = async () => {
      throw new Error('Echec permanent simule.');
    };
    const handlers = new Map<string, readonly OutboxEventHandler[]>([
      ['shared-kernel-test.dead-letter', [handler]],
    ]);

    const { queue, connection } = createTestOutboxQueue();
    activeQueues.push({ queue, connection });
    const worker = createOutboxWorker({ prisma, handlers, connection, queueName: queue.name, workerId });
    activeWorkers.push(worker);
    const outcome = waitForJobOutcome(worker, id);
    void worker.run();

    await relayOutboxOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });
    await expect(outcome).resolves.toBe('failed');

    const row = await readOutboxRow(id);
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
  });

  it("un job BullMQ forge (id absent de platform.OutboxMessage) est un no-op silencieux, jamais une invocation de handler — Redis n_est pas une frontiere de confiance", async () => {
    const forgedId = uniqueId(); // JAMAIS insere en base
    const workerId = `test-worker-${uniqueId()}`;
    let callCount = 0;
    const handlers = new Map<string, readonly OutboxEventHandler[]>([
      ['shared-kernel-test.forged', [async () => { callCount += 1; }]],
    ]);

    const { queue, connection } = createTestOutboxQueue();
    activeQueues.push({ queue, connection });
    const worker = createOutboxWorker({ prisma, handlers, connection, queueName: queue.name, workerId });
    activeWorkers.push(worker);
    const outcome = waitForJobOutcome(worker, forgedId);
    void worker.run();

    // Enfilage DIRECT (contourne le relais/la reclamation SQL) : simule un job ecrit directement
    // dans Redis par un tiers ayant acces au reseau Redis.
    await queue.add('shared-kernel-test.forged', { id: forgedId }, {
      jobId: buildOutboxJobId(forgedId, 0),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });

    // Le worker resout le job SANS lever (no-op logge, jamais une exception qui masquerait la
    // cause) : cote BullMQ, cela se traduit par un evenement 'completed', pas 'failed'.
    await expect(outcome).resolves.toBe('completed');
    expect(callCount).toBe(0);
  });

  it("un message dont payload.tenantId diverge de la colonne tenant_id reelle n_invoque aucun handler (integrite, defense en profondeur)", async () => {
    const id = uniqueId();
    const workerId = `test-worker-${uniqueId()}`;
    const realTenantId = uniqueId();
    const forgedTenantId = uniqueId();
    await insertOutboxRow({
      id,
      eventType: 'shared-kernel-test.tenant-mismatch',
      status: 'PENDING',
      attempts: 0,
      tenantId: realTenantId,
      payload: { tenantId: forgedTenantId },
    });

    let callCount = 0;
    const handlers = new Map<string, readonly OutboxEventHandler[]>([
      ['shared-kernel-test.tenant-mismatch', [async () => { callCount += 1; }]],
    ]);

    const { queue, connection } = createTestOutboxQueue();
    activeQueues.push({ queue, connection });
    const worker = createOutboxWorker({ prisma, handlers, connection, queueName: queue.name, workerId });
    activeWorkers.push(worker);
    const outcome = waitForJobOutcome(worker, id);
    void worker.run();

    await relayOutboxOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });

    // Traite comme un ECHEC ordinaire (compte dans attempts, PAS un no-op silencieux — voir
    // OutboxWorker.ts, assertPayloadTenantIdConsistent) : le handler n'est JAMAIS invoque.
    await expect(outcome).resolves.toBe('failed');
    expect(callCount).toBe(0);
    const row = await readOutboxRow(id);
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
  });

  it(
    'un job dont le worker est tue en cours de traitement (force-close) est redistribue par le mecanisme "stalled" de BullMQ, bien avant le delai de reprise Postgres (5 min)',
    async () => {
      const id = uniqueId();
      const workerId = `test-worker-${uniqueId()}`;
      await insertOutboxRow({ id, eventType: 'shared-kernel-test.stalled-recovery', status: 'PENDING', attempts: 0 });

      const { queue, connection } = createTestOutboxQueue();
      activeQueues.push({ queue, connection });
      await relayOutboxOnce({ prisma, queue, workerId, batchSize: GENEROUS_BATCH_SIZE });

      // Timings REDUITS (uniquement pour ce test) : un `lockDuration`/`stalledInterval` de
      // production (60s/30s) rendrait ce test inutilement lent — la PROPRIETE testee (BullMQ
      // redistribue bien plus vite que `staleLockMinutes`) reste la meme quelle que soit l'echelle.
      const smallTimings = { lockDuration: 300, stalledInterval: 300, maxStalledCount: 1 };

      // Worker A : handler qui ne resout JAMAIS — simule un traitement bloque/un processus qui
      // plante EN COURS de traitement (jamais un succes, jamais une exception).
      const handlersA = new Map<string, readonly OutboxEventHandler[]>([
        ['shared-kernel-test.stalled-recovery', [async () => new Promise<void>(() => {})]],
      ]);
      const workerA = createOutboxWorker({
        prisma,
        handlers: handlersA,
        connection,
        queueName: queue.name,
        workerId,
        ...smallTimings,
      });
      activeWorkers.push(workerA);
      void workerA.run();

      const jobId = buildOutboxJobId(id, 1);
      await waitUntilJobActive(queue, jobId);

      // Simule un crash : fermeture FORCEE, sans attendre la fin du job en cours (le verrou BullMQ
      // reste pose, exactement comme un processus tue brutalement).
      await workerA.close(true);

      const handlersB = new Map<string, readonly OutboxEventHandler[]>([
        ['shared-kernel-test.stalled-recovery', [async () => undefined]],
      ]);
      const workerB = createOutboxWorker({
        prisma,
        handlers: handlersB,
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
      const elapsedMs = Date.now() - startedWaitingAt;

      // Bien en-deca du delai de reprise Postgres (`staleLockMinutes`, 5 min par defaut) : preuve
      // que c'est bien le mecanisme "stalled" de BullMQ (ici configure a ~300ms) qui a redistribue
      // le job, pas une reclamation SQL tardive.
      expect(elapsedMs).toBeLessThan(10_000);

      const row = await readOutboxRow(id);
      expect(row.status).toBe('PROCESSED');
    },
    20_000,
  );
});
