/**
 * Constantes partagees entre `OutboxRelay.ts` (reclamation SQL des messages `PENDING`/
 * `PROCESSING` perimes) et `shared-kernel/infrastructure/queue/OutboxWorker.ts` (decision
 * PENDING/FAILED apres l'invocation des handlers) — un SEUL point de verite pour ces valeurs,
 * jamais deux constantes dupliquees qui pourraient diverger entre la reclamation et le traitement
 * d'un MEME message.
 *
 * Extrait de OutboxRelay.ts a l'etape 6/13 (migration du relais vers BullMQ, ADR-0004) : ces
 * valeurs existaient deja a l'etape 5/13, inchangees ici.
 */
export const OUTBOX_DEFAULT_BATCH_SIZE = 25;
export const OUTBOX_DEFAULT_STALE_LOCK_MINUTES = 5;
/** Au-dela de ce nombre de tentatives, un message passe `FAILED` (dead-letter) plutot que d'etre remis en file `PENDING`. */
export const OUTBOX_MAX_ATTEMPTS = 8;
/** Troncature de `lastError` (colonne TEXT non bornee cote Postgres, mais un message d'erreur illimite n'a pas de valeur diagnostique au-dela de cette longueur). */
export const OUTBOX_MAX_ERROR_LENGTH = 2000;
