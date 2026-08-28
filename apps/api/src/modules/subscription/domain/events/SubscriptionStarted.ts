import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis au demarrage d'un abonnement (essai gratuit STANDARD, O-02.5). Consommateur reel :
 * `identity.grantOwnerMembershipOnSubscriptionStarted` (ADR-0008 §1/§4/§9, resequencement F3 de
 * la revue de securite de l'etape 10/13 — voir GrantOwnerMembershipOnSubscriptionStarted.ts) ;
 * `notifications.sendWelcomeEmailOnSubscriptionStarted` (etape 9) egalement branche.
 *
 * `ownerUserId` (ADR-0008 §9, resequencement F3) : identifiant du `UserAccount` a l'origine du
 * provisioning, relu depuis `HealthFacilityCreated.ownerUserId` par
 * `StartTrialSubscriptionOnHealthFacilityCreated.ts` et propage ici — AJOUT ADDITIF au sens de la
 * convention de versionnage de docs/domain/events.md : `eventVersion` reste 1, aucun champ
 * existant n'est renomme ni supprime. Ce champ sera TOUJOURS renseigne en pratique (aucun chemin
 * de code n'appelle `Subscription.startTrial()` sans `ownerUserId`), mais reste additif au sens du
 * schema : un consommateur qui lirait un jour un message historique depourvu du champ ne doit
 * jamais inventer une identite par defaut (meme discipline que `HealthFacilityCreated.ownerUserId`
 * — voir ADR-0008 §9, amendement 1).
 */
export class SubscriptionStarted implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'subscription.subscription.started';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly planId: string;
  readonly trialEndsAt: string | null;
  readonly ownerUserId: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    planId: string;
    trialEndsAt: string | null;
    ownerUserId: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.planId = params.planId;
    this.trialEndsAt = params.trialEndsAt;
    this.ownerUserId = params.ownerUserId;
  }

  static create(params: {
    subscriptionId: string;
    tenantId: string;
    planId: string;
    trialEndsAt: Date | null;
    ownerUserId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SubscriptionStarted {
    return new SubscriptionStarted({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.subscriptionId,
      tenantId: params.tenantId,
      planId: params.planId,
      trialEndsAt: params.trialEndsAt === null ? null : params.trialEndsAt.toISOString(),
      ownerUserId: params.ownerUserId,
    });
  }
}
