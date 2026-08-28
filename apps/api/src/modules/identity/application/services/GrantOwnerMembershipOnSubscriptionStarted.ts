import { z } from 'zod';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import type { GrantMembershipHandler } from '../commands/GrantMembership.js';

/** Forme attendue du payload de `subscription.subscription.started` (module `subscription`) — voir le commentaire equivalent dans IssuePlatformInvoiceOnRenewalDue.ts (module `payment`) sur la raison d'un schema de frontiere ici : ce module ne partage AUCUN type statique avec `subscription`, la frontiere de confiance impose de revalider la forme du JSON persiste. */
const SubscriptionStartedPayloadSchema = z
  .object({
    ownerUserId: z.string().min(1),
  })
  .passthrough();

/**
 * Consommateur Outbox de `SubscriptionStarted` (module `subscription`) cote Identity — DEUXIEME
 * etape chorographiee de la Saga de provisioning (ADR-0008 §1/§4/§9, RESEQUENCEMENT F3 de la
 * revue de securite independante de l'etape 10/13) : accorde le role `ADMIN_ETABLISSEMENT` au
 * `UserAccount` a l'origine du provisioning UNE FOIS l'abonnement d'essai reellement demarre —
 * plus jamais en parallele de `subscription.startTrialSubscriptionOnHealthFacilityCreated`.
 *
 * **Correctif F3 (revue de securite independante, Moyen)** : l'implementation precedente
 * (`GrantOwnerMembershipOnHealthFacilityCreated.ts`, retire) branchait ce consommateur EN
 * PARALLELE de `startTrialSubscriptionOnHealthFacilityCreated` sur le MEME `eventType`
 * (`tenant.health-facility.created`) — la chorographie de l'ADR (§1) prescrit une chaine
 * STRICTEMENT SEQUENTIELLE (`HealthFacilityCreated → StartTrialSubscription → SubscriptionStarted
 * → GrantMembership → MembershipGranted → ...`), jamais deux etapes en concurrence sur le meme
 * declencheur pour DEUX evenements de la Saga qui n'ont pas de dependance causale imposee entre
 * eux par construction. Consequence reelle constatee : `MembershipGranted`
 * (donc potentiellement `ProvisioningCompleted` en aval) pouvait etre emis pour un tenant qui
 * n'avait PAS ENCORE de `Subscription` (retard, catalogue de plans non seede au premier passage,
 * etc.) — aucune garantie d'ordre entre les deux branches paralleles de l'ancienne chorographie.
 * Ce fichier ferme ce point : `GrantMembership` ne peut plus s'executer avant que
 * `SubscriptionStarted` n'ait ete effectivement emis ET consomme par le relais Outbox.
 *
 * `ownerUserId` est desormais lu depuis le payload de `SubscriptionStarted` (et non plus depuis
 * `HealthFacilityCreated`) — voir `events/SubscriptionStarted.ts` (ADR-0008 §9, ajout additif,
 * `eventVersion` reste 1) et `StartTrialSubscriptionOnHealthFacilityCreated.ts` (qui le relit
 * depuis `HealthFacilityCreated` et le propage).
 *
 * `createdBy: ownerUserId` — DECISION PROPRE A CETTE IMPLEMENTATION (deja signalee a
 * l'architecte lors de la premiere tranche de cette etape, inchangee par ce resequencement) : au
 * moment ou ce consommateur s'execute, AUCUN autre acteur n'existe encore dans le contexte du
 * provisioning (pas d'administrateur plateforme, pas de session ouverte) — le membership initial
 * ADMIN_ETABLISSEMENT est donc "auto-accorde" par construction de la Saga, jamais un octroi
 * effectue par un tiers. `GrantMembershipHandler` n'exige qu'un `UserAccountId` syntaxiquement
 * valide pour `createdBy` (aucune verification d'existence distincte de `userId`), ce choix est
 * donc sans risque de securite : le SEUL beneficiaire possible reste `ownerUserId` lui-meme, deja
 * verifie existant par `CreateHealthFacilityHandler` (ADR-0008 §9) avant meme la creation du
 * tenant.
 *
 * IDEMPOTENT PAR CONSTRUCTION (seconde ligne de defense, derriere `withOutboxIdempotency`) :
 * `MEMBERSHIP_ALREADY_EXISTS` (Result.failure metier de `GrantMembershipHandler`, jamais une
 * exception) est traite comme une etape DEJA FAITE — meme discipline que
 * `StartTrialSubscriptionOnHealthFacilityCreated.ts`.
 */
export function createGrantOwnerMembershipOnSubscriptionStartedHandler(deps: {
  grantMembershipHandler: GrantMembershipHandler;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    if (envelope.tenantId === null) {
      throw new Error(
        `tenantId absent sur l'enveloppe de ${envelope.eventType} (message ${envelope.id}) — un evenement Subscription porte toujours un tenant.`,
      );
    }

    const parsed = SubscriptionStartedPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      // Couvre explicitement le cas "evenement historique sans ownerUserId" (meme discipline
      // qu'ADR-0008 §9, amendement 1 : "n'existe pas en pratique... un consommateur qui lirait un
      // jour un evenement historique depourvu du champ ne doit JAMAIS inventer une identite par
      // defaut") — echec explicite, message Outbox retente puis dead-lettre, jamais une valeur
      // devinee.
      throw new Error(
        `Payload invalide pour ${envelope.eventType} (outbox message ${envelope.id}) : ${parsed.error.message}`,
      );
    }
    const { ownerUserId } = parsed.data;

    const result = await deps.grantMembershipHandler.execute({
      userId: ownerUserId,
      tenantId: envelope.tenantId,
      createdBy: ownerUserId,
      initialRoleCodes: ['ADMIN_ETABLISSEMENT'],
    });
    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'MEMBERSHIP_ALREADY_EXISTS') {
        // Etape deja realisee (rejeu at-least-once ou course entre deux workers Outbox) — succes
        // idempotent du point de vue de la Saga, rien a reessayer.
        return;
      }
      // INVALID_USER_ID / INVALID_TENANT_ID / USER_NOT_FOUND / ROLE_NOT_FOUND : anomalie reelle
      // (catalogue de roles non seede, ou incoherence de donnees) — jamais avalee silencieusement,
      // le message Outbox reste PENDING et sera retente (ADR-0008 §5).
      throw new Error(
        `GrantMembership (ADMIN_ETABLISSEMENT) a echoue pour le tenant ${envelope.tenantId} (message ${envelope.id}) : ${error}`,
      );
    }
  };
}
