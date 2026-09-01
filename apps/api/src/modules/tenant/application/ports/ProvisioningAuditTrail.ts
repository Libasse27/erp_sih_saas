/**
 * Types d'evenement d'audit `PROVISIONING` (ADR-0009 §2.2). Union primitive DUPLIQUEE de
 * `modules/audit/domain/value-objects/AuditEventType.ts` (jamais importee depuis `tenant` : un
 * module n'importe jamais le domain/ d'un autre module) — meme discipline qu'ADR-0005 §5
 * (`AuditTrail.ts::MfaAuditEventType`). `composition-root.ts` est le SEUL point du code autorise a
 * traduire cette union primitive vers les VO du module `audit`.
 */
export type ProvisioningAuditEventType =
  | 'PROVISIONING_FACILITY_CREATED'
  | 'PROVISIONING_CONFIGURATION_SEEDED'
  | 'PROVISIONING_COMPLETED';

/** Cible d'un fait de provisioning — miroir primitif d'`AuditTargetType` (module `audit`), aux seules valeurs pertinentes ici. */
export type ProvisioningAuditTargetType = 'HEALTH_FACILITY' | 'FACILITY_SETTINGS';

/**
 * "Depuis quel contexte" — miroir primitif d'`ActorKind` (module `audit`). `PROVISIONING_*` n'a
 * aujourd'hui AUCUN producteur avec un acteur humain threadeé (Saga chorographiee par l'Outbox,
 * `CreateHealthFacilityHandler` invoque hors de toute session — voir le rapport de cette etape) :
 * `SYSTEM` est la SEULE valeur emise a ce jour, le type reste neanmoins ouvert pour rester correct
 * si un futur endpoint interactif de provisioning est ajoute.
 */
export type ProvisioningActorKind = 'SYSTEM' | 'USER_PLATFORM' | 'USER_TENANT';

export interface ProvisioningAuditRecordInput {
  readonly eventType: ProvisioningAuditEventType;
  readonly outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  readonly tenantId: string;
  readonly actorKind: ProvisioningActorKind;
  readonly actorUserId: string | null;
  readonly subjectUserId: string | null;
  readonly targetType: ProvisioningAuditTargetType;
  readonly targetId: string;
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
}

/**
 * Port sortant de `tenant` vers le module `audit` (ADR-0009 §2.2/§4). L'implementation reelle est
 * cablee dans `composition-root.ts` (seul point du code autorise a connaitre les deux modules).
 *
 * NON NEGOCIABLE (ADR-0009 §4) : `record()` DOIT etre appele DANS LA TRANSACTION COURANTE (via
 * `resolvePrismaClient`), jamais depuis un consommateur Outbox dont la SEULE fonction serait
 * d'ecrire de l'audit. Un consommateur Outbox qui EXECUTE lui-meme la commande (et mute
 * l'agregat) ecrit son entree dans SA PROPRE transaction — c'est le regime deja en place.
 */
export interface ProvisioningAuditTrail {
  record(input: ProvisioningAuditRecordInput): Promise<void>;
}
