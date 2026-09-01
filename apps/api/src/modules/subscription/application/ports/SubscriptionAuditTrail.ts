/**
 * Types d'evenement d'audit `SUBSCRIPTION` (ADR-0009 §2.2). Union primitive DUPLIQUEE de
 * `modules/audit/domain/value-objects/AuditEventType.ts` (jamais importee depuis `subscription` :
 * un module n'importe jamais le domain/ d'un autre module) — meme discipline qu'ADR-0005 §5.
 */
export type SubscriptionAuditEventType =
  | 'SUBSCRIPTION_TRIAL_STARTED'
  | 'SUBSCRIPTION_PLAN_UPGRADE_REQUESTED'
  | 'SUBSCRIPTION_PLAN_CHANGED'
  | 'SUBSCRIPTION_RENEWED'
  | 'SUBSCRIPTION_GRACE_PERIOD_STARTED'
  | 'SUBSCRIPTION_DEGRADED_MODE_ENTERED'
  | 'SUBSCRIPTION_DEGRADED_MODE_SUSTAINED'
  | 'SUBSCRIPTION_REACTIVATED';

/**
 * "Depuis quel contexte" — miroir primitif d'`ActorKind`. AUCUN handler de ce module (commandes
 * comme services Outbox) ne threade d'acteur humain a ce jour (voir le rapport de cette etape) :
 * `SYSTEM` est la SEULE valeur emise. Le type reste ouvert pour rester correct si un futur
 * endpoint interactif (upgrade demande depuis une session TENANT) fait evoluer
 * `UpgradeSubscriptionPlanHandler`.
 */
export type SubscriptionActorKind = 'SYSTEM' | 'USER_TENANT' | 'USER_PLATFORM';

export interface SubscriptionAuditRecordInput {
  readonly eventType: SubscriptionAuditEventType;
  readonly outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  readonly tenantId: string;
  readonly actorKind: SubscriptionActorKind;
  readonly actorUserId: string | null;
  readonly targetId: string;
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
}

/**
 * Port sortant de `subscription` vers le module `audit` (ADR-0009 §2.2/§4). L'implementation
 * reelle est cablee dans `composition-root.ts`. `record()` DOIT etre appele DANS LA TRANSACTION
 * COURANTE, jamais depuis un consommateur Outbox dont la SEULE fonction serait d'ecrire de
 * l'audit — un consommateur qui EXECUTE lui-meme la commande ecrit dans SA PROPRE transaction.
 */
export interface SubscriptionAuditTrail {
  record(input: SubscriptionAuditRecordInput): Promise<void>;
}
