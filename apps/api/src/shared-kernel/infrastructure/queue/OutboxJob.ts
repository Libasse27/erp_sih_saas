/** Nom de la file BullMQ du relais Outbox (etape 6/13, ADR-0004) — UN seul point de verite, partage par `OutboxRelay.ts` (producteur) et `OutboxWorker.ts` (consommateur). */
export const OUTBOX_QUEUE_NAME = 'outbox-relay';

/** Separateur utilise par `buildOutboxJobId`/`parseOutboxJobId` — JAMAIS `:` : BullMQ (6.x) rejette tout `jobId` personnalise contenant `:` sauf format legacy tres specifique (compatibilite jobs repetables, non concerne ici) — voir `Job.validateOptions` dans bullmq. `#` n'apparait jamais dans un UUID v4. */
const OUTBOX_JOB_ID_SEPARATOR = '#';

/**
 * Charge utile d'un job BullMQ du relais Outbox — reduite a L'IDENTIFIANT SEUL de la ligne
 * `platform.OutboxMessage` (correctif de securite, etape 6/13, revue post-implementation).
 *
 * AVANT ce correctif, cette charge portait une COPIE COMPLETE de l'enveloppe (eventType, payload
 * — donc `tenantId` metier, montants, references de paiement — et `attempts`), traitee comme
 * source de verite par `OutboxWorker.ts` pour invoquer les handlers et ouvrir le contexte RLS.
 * Consequence : Redis (accessible reseau, conteneur potentiellement compromis, ou tout simplement
 * un bug d'enfilage) devenait une FRONTIERE DE CONFIANCE non maitrisee — quiconque peut ecrire un
 * job dans cette file peut forger un `tenantId` de son choix et declencher un consommateur
 * financier (`MarkPlatformInvoicePaidOnPaymentSucceeded`...) sans paiement reel ; le RLS protege
 * fidelement le tenant CHOISI PAR L'ATTAQUANT, ce qui ne bloque rien.
 *
 * Desormais, Redis ne transporte QUE cet identifiant (donnee non sensible, ne permet par
 * elle-meme aucune action) : `OutboxWorker.ts` relit la ligne REELLE depuis Postgres avant
 * d'invoquer quoi que ce soit — Postgres reste l'UNIQUE source de verite, jamais court-circuitee
 * par le contenu d'un message Redis. Voir le commentaire de tete de `OutboxWorker.ts` pour le
 * detail des verifications appliquees a cette relecture.
 */
export interface OutboxJobData {
  readonly id: string;
}

/**
 * Construit le `jobId` BullMQ d'un message Outbox reclame — INCLUT le nombre de tentatives
 * (`attempts`, capture par la reclamation SQL, voir `OutboxRelay.ts`) en suffixe, PAS seulement
 * l'identifiant du message : chaque RECLAMATION (chaque incrementation de `attempts`) doit
 * produire un `jobId` BullMQ DISTINCT.
 *
 * Pourquoi : le mecanisme interne de "stalled jobs" de BullMQ (voir OutboxWorker.ts) peut
 * redistribuer un job a un autre worker bien plus vite que le delai de reprise Postgres
 * (`staleLockMinutes`, 5 minutes par defaut). Si le `jobId` ne portait que l'identifiant du
 * message, une reclamation SQL ulterieure (apres expiration du verrou Postgres) pourrait tenter
 * d'enfiler un job dont l'identifiant collisionne SILENCIEUSEMENT avec un job precedent encore
 * actif cote BullMQ (deux "generations" de traitement du meme message, ambigues l'une avec
 * l'autre). Le suffixe rend chaque generation trivialement distincte, et permet a
 * `OutboxWorker.ts` de verifier, en relisant Postgres, que le `attempts` COURANT de la ligne
 * correspond EXACTEMENT a la generation pour laquelle ce job precis a ete enfile — un job d'une
 * generation PERIMEE (message deja reclame a nouveau depuis) est alors un no-op silencieux, pas
 * un double traitement.
 */
export function buildOutboxJobId(outboxMessageId: string, attemptsAtClaim: number): string {
  return `${outboxMessageId}${OUTBOX_JOB_ID_SEPARATOR}${attemptsAtClaim}`;
}

/**
 * Extrait `(outboxMessageId, attemptsAtClaim)` d'un `jobId` construit par `buildOutboxJobId`.
 * `outboxMessageId` est un UUID (jamais de `#`), donc le DERNIER `#` du `jobId` separe sans
 * ambiguite les deux parties. Retourne `null` si le format est inattendu (jamais suppose valide
 * sans verification — frontiere de confiance, §2 du system prompt) : `OutboxWorker.ts` traite
 * alors ce job comme non exploitable (no-op + log), jamais comme une exception non geree.
 */
export function parseOutboxJobId(jobId: string | undefined): { outboxMessageId: string; attemptsAtClaim: number } | null {
  if (jobId === undefined) {
    return null;
  }
  const separatorIndex = jobId.lastIndexOf(OUTBOX_JOB_ID_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }
  const outboxMessageId = jobId.slice(0, separatorIndex);
  const attemptsAtClaim = Number(jobId.slice(separatorIndex + OUTBOX_JOB_ID_SEPARATOR.length));
  if (outboxMessageId.length === 0 || !Number.isInteger(attemptsAtClaim)) {
    return null;
  }
  return { outboxMessageId, attemptsAtClaim };
}
