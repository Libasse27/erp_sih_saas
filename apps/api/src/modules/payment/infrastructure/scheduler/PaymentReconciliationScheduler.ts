import { startPeriodicJob, type PeriodicJobHandle, type PeriodicJobLogger } from '../../../../shared-kernel/infrastructure/persistence/PeriodicJobRunner.js';
import type { ReconcilePendingPaymentsHandler } from '../../application/services/ReconcilePendingPayments.js';

/** Intervalle de polling par defaut du rapprochement — plus frequent que le scheduler de renouvellement (O-25.5 : "le webhook n'est jamais l'unique source de verite", donc un delai de detection court reste utile en cas de panne webhook). */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Demarre le rapprochement periodique de paiements (O-25.5) en tache de fond — cable
 * UNIQUEMENT depuis composition-root.ts, jamais depuis une requete HTTP.
 */
export function startPaymentReconciliationScheduler(params: {
  handler: ReconcilePendingPaymentsHandler;
  intervalMs?: number;
  logger?: PeriodicJobLogger;
}): PeriodicJobHandle {
  return startPeriodicJob({
    name: 'payment-reconciliation-scheduler',
    intervalMs: params.intervalMs ?? DEFAULT_INTERVAL_MS,
    run: async () => {
      await params.handler.execute();
    },
    ...(params.logger !== undefined ? { logger: params.logger } : {}),
  });
}
