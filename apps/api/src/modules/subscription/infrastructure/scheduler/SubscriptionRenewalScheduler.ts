import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from '../../../../shared-kernel/infrastructure/persistence/PeriodicJobRunner.js';
import type { ProcessSubscriptionRenewalsHandler } from '../../application/services/ProcessSubscriptionRenewals.js';

/** Intervalle de polling par defaut du scheduler de renouvellement — un cycle quotidien suffit largement au regard des durees O-03.2 (grace 7j, degrade 30j), mais un intervalle plus court (ex. horaire) reduit la latence de detection sans cout notable. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 heure

/**
 * Demarre le scheduler de renouvellement (O-25.6) en tache de fond — cable UNIQUEMENT depuis
 * composition-root.ts (`startBackgroundJobs`), jamais depuis une requete HTTP. Utilise
 * `PeriodicJobRunner` (shared-kernel) : jamais deux cycles en meme temps, arret propre attendu
 * par `SIGTERM`.
 */
export function startSubscriptionRenewalScheduler(params: {
  handler: ProcessSubscriptionRenewalsHandler;
  intervalMs?: number;
  logger?: PeriodicJobLogger;
}): PeriodicJobHandle {
  return startPeriodicJob({
    name: 'subscription-renewal-scheduler',
    intervalMs: params.intervalMs ?? DEFAULT_INTERVAL_MS,
    run: async () => {
      await params.handler.execute();
    },
    ...(params.logger !== undefined ? { logger: params.logger } : {}),
  });
}
