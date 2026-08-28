import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import type { SeedFacilityConfigurationHandler } from '../commands/SeedFacilityConfiguration.js';

/**
 * Consommateur Outbox de `MembershipGranted` (module `identity`) cote Tenant — troisieme etape
 * chorographiee de la Saga de provisioning (ADR-0008 §1/§4/§10, amendement 1, Phase 0 etape
 * 10/13) : seme la configuration technique minimale du tenant des qu'un membership vient d'etre
 * accorde.
 *
 * CHOIX DE DECLENCHEUR — decision propre a cette implementation, l'ADR autorisait explicitement
 * plusieurs constructions ("MembershipGranted, ou l'evenement le plus approprie") : ce
 * consommateur reagit a TOUT `MembershipGranted`, pas seulement au tout premier octroi
 * `ADMIN_ETABLISSEMENT` du provisioning initial. C'est SANS CONSEQUENCE car
 * `SeedFacilityConfigurationHandler` est idempotent PAR TENANT (une ligne `FacilitySettings`
 * existante -> `FACILITY_SETTINGS_ALREADY_EXISTS`, traite ci-dessous comme un succes) : un futur
 * octroi de membership (ex. ajout d'un second utilisateur au meme tenant, hors perimetre actuel
 * mais deja possible via `GrantMembershipHandler`) redeclenche ce consommateur SANS effet
 * (aucun nouveau seed, aucune erreur) — a signaler a l'architecte comme point de vigilance si un
 * jour ce declencheur devient couteux (ce qui n'est pas le cas ici : une seule lecture indexee par
 * tenant).
 *
 * N'EXTRAIT AUCUN CHAMP du payload de l'evenement (`userId`) : seul `envelope.tenantId` (colonne
 * Postgres de l'Outbox) est utilise — meme discipline que
 * `StartTrialSubscriptionOnHealthFacilityCreated.ts`.
 */
export function createSeedFacilityConfigurationOnMembershipGrantedHandler(deps: {
  seedFacilityConfigurationHandler: SeedFacilityConfigurationHandler;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    if (envelope.tenantId === null) {
      throw new Error(
        `tenantId absent sur l'enveloppe de ${envelope.eventType} (message ${envelope.id}) — un evenement MembershipGranted porte toujours un tenant.`,
      );
    }

    const result = await deps.seedFacilityConfigurationHandler.execute({ tenantId: envelope.tenantId });
    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'FACILITY_SETTINGS_ALREADY_EXISTS') {
        // Etape deja realisee (rejeu at-least-once, ou membership supplementaire sur un tenant
        // deja configure — voir commentaire de tete) — succes idempotent du point de vue de la
        // Saga, rien a reessayer.
        return;
      }
      // INVALID_TENANT_ID : anomalie reelle (tenantId corrompu) — jamais avalee silencieusement,
      // le message Outbox reste PENDING et sera retente (ADR-0008 §5).
      throw new Error(
        `SeedFacilityConfiguration a echoue pour le tenant ${envelope.tenantId} (message ${envelope.id}) : ${error}`,
      );
    }
  };
}
