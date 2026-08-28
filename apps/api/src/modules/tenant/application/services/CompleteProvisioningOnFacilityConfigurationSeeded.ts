import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import type { CompleteProvisioningHandler } from '../commands/CompleteProvisioning.js';

/**
 * Consommateur Outbox de `FacilityConfigurationSeeded` (module `tenant`, cet evenement est emis
 * ET consomme par le MEME module — voir composition-root.ts) — derniere etape chorographiee de
 * la Saga de provisioning (ADR-0008 §1/§4/§11, amendement 1, Phase 0 etape 10/13) : cloture la
 * Saga en emettant `ProvisioningCompleted` (signal minimal, AUCUNE machine a etats metier).
 *
 * N'EXTRAIT AUCUN CHAMP du payload de l'evenement (`locale`/`timezone`/`currency`/
 * `phoneCountryCode`) : seul `envelope.tenantId` est utilise — meme discipline que les autres
 * consommateurs de cette Saga.
 *
 * IDEMPOTENT PAR CONSTRUCTION (seconde ligne de defense, derriere `withOutboxIdempotency`) :
 * `CompleteProvisioningHandler.execute()` retourne `PROVISIONING_ALREADY_COMPLETED` (Result.failure
 * metier) des qu'un `FacilitySettings` de ce tenant porte deja `provisioningCompletedAt` — un
 * rejeu (ou une course entre deux workers Outbox) est donc traite comme une etape DEJA FAITE,
 * jamais une erreur. `FACILITY_SETTINGS_NOT_FOUND` reste en revanche un ECHEC REEL (l'etape
 * precedente de la Saga n'a pas encore ete rejouee) : fait lever une exception pour que le
 * message Outbox reste `PENDING` et soit retente (ADR-0008 §5).
 */
export function createCompleteProvisioningOnFacilityConfigurationSeededHandler(deps: {
  completeProvisioningHandler: CompleteProvisioningHandler;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    if (envelope.tenantId === null) {
      throw new Error(
        `tenantId absent sur l'enveloppe de ${envelope.eventType} (message ${envelope.id}) — un evenement FacilityConfigurationSeeded porte toujours un tenant.`,
      );
    }

    const result = await deps.completeProvisioningHandler.execute({ tenantId: envelope.tenantId });
    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'PROVISIONING_ALREADY_COMPLETED') {
        // Etape deja realisee (rejeu at-least-once, ou course entre deux workers Outbox) —
        // succes idempotent du point de vue de la Saga, rien a reessayer.
        return;
      }
      // INVALID_TENANT_ID / FACILITY_SETTINGS_NOT_FOUND : anomalie reelle — jamais avalee
      // silencieusement, le message Outbox reste PENDING et sera retente (ADR-0008 §5).
      throw new Error(
        `CompleteProvisioning a echoue pour le tenant ${envelope.tenantId} (message ${envelope.id}) : ${error}`,
      );
    }
  };
}
