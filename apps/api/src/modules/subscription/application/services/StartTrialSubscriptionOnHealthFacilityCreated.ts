import { z } from 'zod';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import type { StartTrialSubscriptionHandler } from '../commands/StartTrialSubscription.js';

/** Forme attendue du payload de `tenant.health-facility.created` (module `tenant`) — meme raison qu'un schema de frontiere dans GrantOwnerMembershipOnSubscriptionStarted.ts (module `identity`) : ce module ne partage AUCUN type statique avec `tenant`, la frontiere de confiance impose de revalider la forme du JSON persiste. */
const HealthFacilityCreatedPayloadSchema = z
  .object({
    ownerUserId: z.string().min(1),
  })
  .passthrough();

/**
 * Consommateur Outbox de `HealthFacilityCreated` (module `tenant`) cote Subscription — premiere
 * etape chorographiee de la Saga de provisioning (ADR-0008 §1/§4, Phase 0 etape 10/13) : demarre
 * automatiquement l'essai gratuit STANDARD (O-02.5) des qu'un etablissement est provisionne,
 * sans attendre un appel applicatif distinct.
 *
 * `ownerUserId` (ADR-0008 §9, RESEQUENCEMENT F3 de la revue de securite de l'etape 10/13) : ce
 * consommateur RELIT desormais `ownerUserId` depuis le payload de `HealthFacilityCreated` (meme
 * schema Zod de frontiere que l'ancien `GrantOwnerMembershipOnHealthFacilityCreated.ts`, voir
 * `GrantOwnerMembershipOnSubscriptionStarted.ts` pour la suite de la chaine) et le PROPAGE dans
 * `StartTrialSubscriptionHandler.execute()` — necessaire depuis que `GrantMembership` (etape
 * suivante) ne consomme plus `HealthFacilityCreated` directement mais `SubscriptionStarted`, qui
 * doit donc desormais porter ce champ (voir events/SubscriptionStarted.ts). Avant ce correctif,
 * seul `envelope.tenantId` (colonne Postgres, jamais le payload) etait utilise ici — l'extraction
 * du payload est donc un changement DELIBERE de ce fichier, pas un residu de l'ancienne
 * implementation.
 *
 * IDEMPOTENT PAR CONSTRUCTION (seconde ligne de defense, derriere `withOutboxIdempotency`,
 * exactement la nuance documentee dans docs/domain/events.md "registre de premier niveau, pas
 * absolu") : `StartTrialSubscriptionHandler.execute()` retourne `SUBSCRIPTION_ALREADY_EXISTS`
 * (Result.failure metier, jamais une exception) des qu'un `Subscription` existe deja pour ce
 * tenant — un rejeu du meme evenement (ou une course entre deux workers Outbox, la contrainte
 * UNIQUE `tenant_id` de `platform.Subscription` tranchant en dernier ressort, voir
 * `PrismaSubscriptionRepository.save()`) est donc traite comme une etape DEJA FAITE, un succes du
 * point de vue de la Saga, jamais une erreur qui declencherait une compensation (ADR-0008 §5 :
 * "retry-jusqu'a-completion, pas de compensation destructive").
 *
 * Les echecs `STANDARD_PLAN_NOT_FOUND`/`STANDARD_PLAN_PRICE_NOT_FOUND` (catalogue non seede) sont
 * en revanche des ECHECS REELS : ils font lever une exception, pour que le message Outbox reste
 * `PENDING` et soit retente au cycle suivant (retry-jusqu'a-completion) plutot que d'etre
 * silencieusement avale. Un payload sans `ownerUserId` exploitable (evenement historique corrompu,
 * ADR-0008 §9 amendement 1 : "jamais une identite devinee") est traite de la meme maniere — echec
 * explicite, jamais une valeur par defaut inventee.
 */
export function createStartTrialSubscriptionOnHealthFacilityCreatedHandler(deps: {
  startTrialSubscriptionHandler: StartTrialSubscriptionHandler;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    if (envelope.tenantId === null) {
      throw new Error(
        `tenantId absent sur l'enveloppe de ${envelope.eventType} (message ${envelope.id}) — un evenement HealthFacilityCreated porte toujours un tenant (l'agregat EST le tenant).`,
      );
    }

    const parsed = HealthFacilityCreatedPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      // Couvre explicitement le cas "evenement historique sans ownerUserId" (ADR-0008 §9,
      // amendement 1 : "n'existe pas en pratique... un consommateur qui lirait un jour un
      // HealthFacilityCreated historique depourvu du champ ne doit JAMAIS inventer une identite
      // par defaut") — echec explicite, message Outbox retente puis dead-lettre, jamais une
      // valeur devinee.
      throw new Error(
        `Payload invalide pour ${envelope.eventType} (outbox message ${envelope.id}) : ${parsed.error.message}`,
      );
    }
    const { ownerUserId } = parsed.data;

    const result = await deps.startTrialSubscriptionHandler.execute({ tenantId: envelope.tenantId, ownerUserId });
    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'SUBSCRIPTION_ALREADY_EXISTS') {
        // Etape deja realisee (rejeu at-least-once ou course entre deux workers Outbox) — succes
        // idempotent du point de vue de la Saga, rien a reessayer.
        return;
      }
      // INVALID_TENANT_ID / STANDARD_PLAN_NOT_FOUND / STANDARD_PLAN_PRICE_NOT_FOUND : anomalie
      // reelle (tenantId corrompu ou catalogue non seede) — jamais avalee silencieusement, le
      // message Outbox reste PENDING et sera retente (ADR-0008 §5).
      throw new Error(
        `StartTrialSubscription a echoue pour le tenant ${envelope.tenantId} (message ${envelope.id}) : ${error}`,
      );
    }
  };
}
