/**
 * Execution periodique minimale (polling), reutilisee par le relais Outbox (OutboxRelay.ts), le
 * scheduler de renouvellement d'abonnement (subscription/infrastructure/scheduler) et le
 * rapprochement de paiements (payment/infrastructure/scheduler). Un seul point d'implementation
 * pour : ne jamais chevaucher deux executions du meme job (`running`), et un arret propre
 * (`stop()`) qui attend la fin du cycle en cours — necessaire pour `SIGTERM`
 * (01-target-architecture.md §8 : "fin des requetes en cours, drain des workers").
 *
 * Volontairement `setInterval`, pas BullMQ (meme justification que OutboxRelay.ts : pas de
 * dependance supplementaire pour un besoin de polling simple).
 */
export interface PeriodicJobLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

export interface PeriodicJobHandle {
  stop(): Promise<void>;
}

export function startPeriodicJob(params: {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  logger?: PeriodicJobLogger;
}): PeriodicJobHandle {
  let stopped = false;
  let running = false;
  let currentRun: Promise<void> = Promise.resolve();

  const tick = (): void => {
    if (stopped || running) {
      return;
    }
    running = true;
    currentRun = params
      .run()
      .catch((error: unknown) => {
        params.logger?.error(
          { event: 'periodic-job.failed', job: params.name, error: error instanceof Error ? error.message : String(error) },
          `Echec d'execution du job periodique "${params.name}"`,
        );
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, params.intervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await currentRun;
    },
  };
}
