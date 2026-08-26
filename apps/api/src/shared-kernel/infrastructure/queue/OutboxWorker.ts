import type { ConnectionOptions } from 'bullmq';
import { Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../application/OutboxEventHandler.js';
import { OUTBOX_MAX_ATTEMPTS, OUTBOX_MAX_ERROR_LENGTH } from '../persistence/OutboxRetryPolicy.js';
import { OUTBOX_QUEUE_NAME, parseOutboxJobId, type OutboxJobData } from './OutboxJob.js';

export interface OutboxWorkerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface OutboxWorkerOptions {
  readonly prisma: PrismaClient;
  /** Table de dispatch : type d'evenement -> handlers enregistres (0..N), DEJA decores par `withOutboxIdempotency` (voir composition-root.ts) — ce worker ne connait pas cette decoration, il invoque simplement les fonctions qu'on lui donne. */
  readonly handlers: ReadonlyMap<string, readonly OutboxEventHandler[]>;
  readonly connection: ConnectionOptions;
  /**
   * Identifiant du relais dont ce worker consomme les jobs — DOIT correspondre EXACTEMENT au
   * `workerId` passe a `relayOutboxOnce()` (voir OutboxRelay.ts, colonne `locked_by`). Sert de
   * verification d'integrite (voir le commentaire de tete de la fonction) : un job dont la ligne
   * Postgres est verrouillee par un AUTRE identifiant n'est jamais traite par ce worker.
   *
   * Limite ASSUMEE de la conception actuelle (un seul processus porte a la fois l'API, le relais
   * et le worker — voir ADR-0004, dette assumee) : cette verification suppose qu'un seul
   * `workerId` logique est en jeu. Un futur decouplage en plusieurs processus/replicas PARTAGEANT
   * le meme `workerId` logique (ex. un identifiant de deploiement plutot que `process.pid`) reste
   * compatible sans changer ce contrat ; des `workerId` DISTINCTS par replica casserait en
   * revanche cette verification et devra etre reconsidere a ce moment-la.
   */
  readonly workerId: string;
  readonly concurrency?: number;
  readonly logger?: OutboxWorkerLogger;
  /** Nom de la file BullMQ ecoutee — par defaut `OUTBOX_QUEUE_NAME` (production, voir composition-root.ts). Parametrable UNIQUEMENT pour permettre aux tests d'integration d'isoler leur propre file Redis (voir test/shared-kernel/integration/), sans jamais partager la file de production entre suites de test paralleles. */
  readonly queueName?: string;
  /** Voir DEFAULT_LOCK_DURATION_MS ci-dessous pour la justification de la valeur par defaut. */
  readonly lockDuration?: number;
  /** Voir DEFAULT_STALLED_INTERVAL_MS ci-dessous. */
  readonly stalledInterval?: number;
  /** Voir DEFAULT_MAX_STALLED_COUNT ci-dessous. */
  readonly maxStalledCount?: number;
}

const DEFAULT_CONCURRENCY = 5;

/**
 * Duree (ms) au-dela de laquelle BullMQ considere qu'un job n'a plus ete "renouvele" par le
 * worker qui le traite et le declare "stalled" (candidat a la redistribution a un autre worker).
 * Valeur RELEVEE par rapport au defaut BullMQ (30s) : les handlers de ce relais sont des
 * transactions Postgres courtes (quelques dizaines a quelques centaines de ms en pratique), 60s
 * laisse une marge confortable pour ne JAMAIS declencher un stall sur un traitement normal, tout
 * en restant tres inferieur a `staleLockMinutes` (5 min, voir OutboxRelay.ts) — un worker
 * REELLEMENT bloque/crashe est donc detecte par BullMQ (stalled) BIEN AVANT que Postgres ne le
 * detecte a son tour (verrou perime). Ce n'est plus dangereux depuis le correctif de securite
 * (etape 6, revue post-implementation) qui fait relire Postgres et verifier `attempts`/`locked_by`
 * a CHAQUE invocation : un job redistribue pour une generation perimee est un no-op, jamais un
 * double traitement (voir le corps de `createOutboxWorker`).
 */
const DEFAULT_LOCK_DURATION_MS = 60_000;
/** Frequence a laquelle CE worker verifie l'existence de jobs stalled (les siens ET ceux d'autres workers de la meme file) — meme valeur que le defaut BullMQ, fixee EXPLICITEMENT pour que la relation avec `DEFAULT_LOCK_DURATION_MS` soit documentee au meme endroit plutot que livree a un defaut implicite. */
const DEFAULT_STALLED_INTERVAL_MS = 30_000;
/** Nombre de fois qu'un job peut etre marque stalled avant que BullMQ lui-meme le marque `failed` (sans le retenter — voir `attempts: 1` a l'enfilage, OutboxRelay.ts) : un simple filet BullMQ, la reprise REELLE reste pilotee par Postgres (`staleLockMinutes`), qui reclamera la ligne independamment de ce que BullMQ decide de son cote. */
const DEFAULT_MAX_STALLED_COUNT = 1;

/**
 * Verifie que `payload.tenantId` (quand le payload en porte un — Published Language entre
 * modules, voir docs/domain/events.md) correspond EXACTEMENT a `envelope.tenantId` (colonne
 * `OutboxMessage.tenant_id`, source de verite). Controle croise de DEFENSE EN PROFONDEUR (le
 * correctif de securite ci-dessus, qui fait relire `tenantId` depuis Postgres plutot que depuis
 * Redis, couvre deja l'essentiel du risque) : une divergence signalerait une incoherence
 * d'ecriture (bug) ou une donnee altere, jamais un cas metier normal — traitee comme un ECHEC de
 * traitement ordinaire (compte dans `attempts`, peut mener au dead-letter), PAS comme un cas
 * silencieusement ignore, car contrairement a un job perime (autre relais/generation), une
 * incoherence sur LA ligne elle-meme ne se resorira pas seule au prochain cycle.
 */
function assertPayloadTenantIdConsistent(envelope: OutboxEventEnvelope): void {
  if (typeof envelope.payload !== 'object' || envelope.payload === null) {
    return;
  }
  const payloadTenantId = (envelope.payload as Record<string, unknown>).tenantId;
  if (typeof payloadTenantId !== 'string') {
    return;
  }
  if (payloadTenantId !== envelope.tenantId) {
    throw new Error(
      `Incoherence d'integrite sur le message Outbox ${envelope.id} : payload.tenantId (${payloadTenantId}) ` +
        `differe de la colonne tenant_id (${String(envelope.tenantId)}).`,
    );
  }
}

/**
 * Worker BullMQ du relais Outbox (ADR-0004, etape 6/13) — consomme les jobs enfiles par
 * `OutboxRelay.ts`.
 *
 * SECURITE (correctif post-revue) : le job BullMQ ne porte QUE l'identifiant de la ligne
 * (`OutboxJobData`, voir OutboxJob.ts) — jamais son contenu. AVANT d'invoquer le moindre handler,
 * ce worker :
 *   1. Parse le `jobId` BullMQ (`<id>#<attempts capture a la reclamation>`, voir
 *      `parseOutboxJobId`) — un format inattendu est un no-op logge, jamais une exception.
 *   2. Verifie que `job.data.id` correspond a l'identifiant extrait du `jobId` (coherence
 *      interne du job lui-meme).
 *   3. RELIT la ligne REELLE `platform.OutboxMessage` par cet identifiant — absente => no-op logge
 *      (jamais invoque un handler pour une ligne qui n'existe pas/plus).
 *   4. Verifie `status === 'PROCESSING'`, `locked_by === options.workerId` ET
 *      `attempts === <attempts extrait du jobId>` — tout ecart signifie que ce job correspond a
 *      une reclamation PERIMEE (le message a ete reclame a nouveau depuis, par ce relais ou un
 *      autre) : no-op logge, jamais un retraitement en double.
 *   5. Construit l'enveloppe et verifie `assertPayloadTenantIdConsistent` (defense en profondeur).
 *
 * C'est cette relecture Postgres, PAS le contenu du job Redis, qui determine `eventType`,
 * `tenantId`, `payload` et le seuil de dead-letter (`attempts`) — Redis reste un simple support de
 * distribution, jamais une frontiere de confiance.
 *
 * Mise a jour de `platform.OutboxMessage` en consequence, avec la MEME garde `(status, locked_by)`
 * dans le `WHERE` de l'`UPDATE` (protege contre une reclamation qui aurait change PENDANT le
 * traitement, ex. redistribution BullMQ concurrente — voir DEFAULT_LOCK_DURATION_MS) :
 *   - succes -> `PROCESSED`.
 *   - echec ET `attempts` encore sous `OUTBOX_MAX_ATTEMPTS` -> remis `PENDING`.
 *   - echec ET `attempts >= OUTBOX_MAX_ATTEMPTS` -> `FAILED` (dead-letter, intervention manuelle).
 *
 * En cas d'echec, le LOG est ecrit AVANT la mise a jour Postgres (jamais apres) : si la mise a
 * jour elle-meme echoue, l'erreur d'ORIGINE du handler reste journalisee — une panne Postgres
 * secondaire est journalisee separement, jamais silencieusement a la place de la premiere.
 * Rethrow SYSTEMATIQUE apres (que la mise a jour Postgres reussisse ou non) : laisser BullMQ
 * marquer le job "failed" de son cote sert l'observabilite, AUCUN retry BullMQ n'est configure
 * (`attempts: 1` a l'ajout, voir OutboxRelay.ts).
 *
 * Construit avec `autorun: false` (voir composition-root.ts) : demarre explicitement par
 * `startBackgroundJobs()`, arrete par `stopBackgroundJobs()` (`worker.close()`, qui attend la fin
 * des jobs en cours — §8 exploitation, arret propre).
 */
export function createOutboxWorker(options: OutboxWorkerOptions): Worker<OutboxJobData> {
  return new Worker<OutboxJobData>(
    options.queueName ?? OUTBOX_QUEUE_NAME,
    async (job) => {
      const parsedJobId = parseOutboxJobId(job.id);
      if (parsedJobId === null) {
        options.logger?.error(
          { event: 'outbox.worker.invalid-job-id', jobId: job.id, outboxMessageId: job.data.id },
          'Job Outbox avec un jobId BullMQ non exploitable (format inattendu) — no-op.',
        );
        return;
      }
      const { outboxMessageId, attemptsAtClaim } = parsedJobId;
      if (outboxMessageId !== job.data.id) {
        options.logger?.error(
          { event: 'outbox.worker.job-id-mismatch', jobId: job.id, dataId: job.data.id },
          'Job Outbox dont le jobId et la charge divergent — no-op.',
        );
        return;
      }

      const row = await options.prisma.outboxMessage.findUnique({ where: { id: outboxMessageId } });
      if (row === null) {
        options.logger?.error(
          { event: 'outbox.worker.unknown-message', outboxMessageId },
          "Job Outbox referencant une ligne platform.OutboxMessage introuvable — no-op (jamais d'invocation de handler sans ligne reelle).",
        );
        return;
      }
      if (row.status !== 'PROCESSING') {
        options.logger?.info(
          { event: 'outbox.worker.stale-job-skipped', outboxMessageId, actualStatus: row.status },
          'Job Outbox perime (statut deja avance par un autre traitement) — no-op.',
        );
        return;
      }
      if (row.lockedBy !== options.workerId) {
        options.logger?.info(
          { event: 'outbox.worker.foreign-lock-skipped', outboxMessageId, lockedBy: row.lockedBy, expectedWorkerId: options.workerId },
          'Job Outbox verrouille par un relais different de celui de ce worker — no-op.',
        );
        return;
      }
      if (row.attempts !== attemptsAtClaim) {
        options.logger?.info(
          { event: 'outbox.worker.superseded-generation-skipped', outboxMessageId, attemptsAtClaim, currentAttempts: row.attempts },
          "Job Outbox d'une generation de reclamation perimee (le message a ete reclame a nouveau depuis) — no-op.",
        );
        return;
      }

      const envelope: OutboxEventEnvelope = {
        id: row.id,
        eventType: row.eventType,
        eventVersion: row.eventVersion,
        aggregateId: row.aggregateId,
        tenantId: row.tenantId,
        occurredAt: row.occurredAt,
        payload: row.payload,
      };
      const handlers = options.handlers.get(envelope.eventType) ?? [];

      try {
        assertPayloadTenantIdConsistent(envelope);
        for (const handler of handlers) {
          await handler(envelope);
        }
        const updated = await options.prisma.outboxMessage.updateMany({
          where: { id: envelope.id, status: 'PROCESSING', lockedBy: options.workerId },
          data: { status: 'PROCESSED', processedAt: new Date(), lockedAt: null, lockedBy: null },
        });
        if (updated.count === 0) {
          options.logger?.info(
            { event: 'outbox.worker.claim-changed-during-processing', outboxMessageId: envelope.id },
            'La reclamation de cette ligne a change pendant le traitement — resultat ignore, une autre reclamation fait deja foi.',
          );
          return;
        }
        options.logger?.info(
          {
            event: 'outbox.message.processed',
            outboxMessageId: envelope.id,
            eventType: envelope.eventType,
            tenantId: envelope.tenantId,
            handlerCount: handlers.length,
          },
          'Message Outbox traite',
        );
      } catch (error) {
        // Log D'ABORD (voir commentaire de tete de fonction) : si la mise a jour Postgres
        // ci-dessous echoue a son tour, l'erreur D'ORIGINE du handler reste journalisee.
        const isDead = row.attempts >= OUTBOX_MAX_ATTEMPTS;
        const message = String(error instanceof Error ? error.message : error).slice(0, OUTBOX_MAX_ERROR_LENGTH);
        options.logger?.error(
          {
            event: 'outbox.message.failed',
            outboxMessageId: envelope.id,
            eventType: envelope.eventType,
            tenantId: envelope.tenantId,
            attempts: row.attempts,
            deadLettered: isDead,
          },
          "Echec de traitement d'un message Outbox",
        );
        try {
          const updated = await options.prisma.outboxMessage.updateMany({
            where: { id: envelope.id, status: 'PROCESSING', lockedBy: options.workerId },
            data: { status: isDead ? 'FAILED' : 'PENDING', lastError: message, lockedAt: null, lockedBy: null },
          });
          if (updated.count === 0) {
            options.logger?.info(
              { event: 'outbox.worker.claim-changed-during-processing', outboxMessageId: envelope.id },
              "La reclamation de cette ligne a change pendant le traitement — l'echec de CE job n'est pas reporte en base.",
            );
          }
        } catch (updateError) {
          options.logger?.error(
            {
              event: 'outbox.worker.postgres-update-failed',
              outboxMessageId: envelope.id,
              error: updateError instanceof Error ? updateError.message : String(updateError),
            },
            "Echec de la mise a jour Postgres consecutive a un handler en erreur — voir l'evenement 'outbox.message.failed' ci-dessus pour la cause d'origine.",
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
