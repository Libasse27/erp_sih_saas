/**
 * Backoff exponentiel CONTROLE (ADR-0007 §6) — ajout deliberement AU-DELA du calque du relais
 * Outbox (qui retente au cycle suivant, 5s, sans delai croissant) : demande explicitement pour ce
 * module (resilience). Fonction PURE, testable sans horloge reelle ni file BullMQ.
 *
 * Paliers : 30s, 60s, 120s, 240s, plafonne a 240s au-dela — evite un delai qui croitrait sans
 * borne jusqu'a `NOTIFICATION_MAX_ATTEMPTS` (voir NotificationRetryPolicy.ts).
 */
const BACKOFF_STEPS_SECONDS: readonly number[] = [30, 60, 120, 240];

export function computeBackoffSeconds(attempts: number): number {
  const index = Math.max(0, attempts - 1);
  return BACKOFF_STEPS_SECONDS[Math.min(index, BACKOFF_STEPS_SECONDS.length - 1)] as number;
}

export function computeNextAttemptAt(attempts: number, now: Date): Date {
  return new Date(now.getTime() + computeBackoffSeconds(attempts) * 1000);
}
