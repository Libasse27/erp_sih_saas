/**
 * Constantes partagees entre `NotificationRelay.ts` et `infrastructure/queue/NotificationWorker.ts`
 * — un seul point de verite (meme raisonnement que `OutboxRetryPolicy.ts`, dont ce fichier est le
 * calque pour le pipeline de livraison des notifications, ADR-0007 §6).
 *
 * `NOTIFICATION_MAX_ATTEMPTS` : parametre OPERATIONNEL (comme `OUTBOX_MAX_ATTEMPTS = 8`, deja en
 * production sans etre traite comme un residu metier) — n'affecte aucun residu O-07 reel
 * (fournisseur, calendrier de rappels), non escalade.
 */
export const NOTIFICATION_DEFAULT_BATCH_SIZE = 25;
export const NOTIFICATION_DEFAULT_STALE_LOCK_MINUTES = 5;
export const NOTIFICATION_MAX_ATTEMPTS = 5;
export const NOTIFICATION_MAX_ERROR_LENGTH = 2000;
