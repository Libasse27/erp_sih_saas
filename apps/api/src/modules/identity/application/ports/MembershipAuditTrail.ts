/**
 * Types d'evenement d'audit `MEMBERSHIP` (ADR-0009 §2.2). Union primitive DUPLIQUEE de
 * `modules/audit/domain/value-objects/AuditEventType.ts` (jamais importee depuis `identity` : un
 * module n'importe jamais le domain/ d'un autre module) — meme discipline qu'`AuditTrail.ts`/
 * `SessionAuditTrail.ts`. TROISIEME port sortant d'Identity vers `audit` (ADR-0009 §4 : "MEMBERSHIP
 * etant produit par identity, ce module reçoit un troisieme port dedie, jamais une extension
 * d'AuditTrail (categorie MFA)").
 *
 * `MEMBERSHIP_ROLE_ASSIGNED`/`MEMBERSHIP_ROLE_UNASSIGNED` : declares (miroir du catalogue
 * `AuditEventType`) mais SANS PRODUCTEUR — aucune commande d'assignation/desassignation de role
 * distincte de `GrantMembership` n'existe dans ce depot (voir le rapport de cette etape).
 */
export type MembershipAuditEventType =
  | 'MEMBERSHIP_GRANTED'
  | 'MEMBERSHIP_REVOKED'
  | 'MEMBERSHIP_ROLE_ASSIGNED'
  | 'MEMBERSHIP_ROLE_UNASSIGNED';

/**
 * "Depuis quel contexte" — miroir primitif d'`ActorKind`. `GrantMembershipHandler` porte deja un
 * `createdBy` (UserAccountId) reel dans TOUS ses appels actuels (Saga de provisioning y compris,
 * "auto-accorde") : `USER_TENANT` est donc la seule valeur emise par ce producteur a ce jour ;
 * `RevokeMembershipHandler` n'a AUCUN acteur threade (aucun appelant production ne l'invoque
 * encore) : `SYSTEM` y est utilise, voir le rapport de cette etape pour la justification complete.
 */
export type MembershipActorKind = 'USER_TENANT' | 'USER_PLATFORM' | 'SYSTEM';

export interface MembershipAuditRecordInput {
  readonly eventType: MembershipAuditEventType;
  readonly outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  readonly tenantId: string;
  readonly actorKind: MembershipActorKind;
  readonly actorUserId: string | null;
  readonly actorRoleCodes: readonly string[];
  readonly subjectUserId: string;
  readonly targetId: string;
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
}

/**
 * Port sortant d'Identity vers le module `audit`, categorie `MEMBERSHIP` (ADR-0009 §2.2/§4).
 * Meme contrat transactionnel qu'`AuditTrail`/`SessionAuditTrail` : `record()` DOIT etre appele
 * DANS la transaction courante, jamais depuis un consommateur Outbox dont la seule fonction
 * serait d'ecrire de l'audit.
 */
export interface MembershipAuditTrail {
  record(input: MembershipAuditRecordInput): Promise<void>;
}
