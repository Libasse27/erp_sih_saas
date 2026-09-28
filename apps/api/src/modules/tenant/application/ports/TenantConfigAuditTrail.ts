/**
 * Types d'evenement d'audit `TENANT_CONFIG` (Phase 1, premier increment vertical — permission
 * `tenant-config:administer`). Union primitive DUPLIQUEE de
 * `modules/audit/domain/value-objects/AuditEventType.ts` (jamais importee depuis `tenant` : un
 * module n'importe jamais le domain/ d'un autre module) — meme discipline que
 * `ProvisioningAuditTrail.ts`. `composition-root.ts` est le SEUL point du code autorise a traduire
 * cette union primitive vers les VO du module `audit`.
 */
export type TenantConfigAuditEventType = 'TENANT_CONFIG_FACILITY_RENAMED';

/**
 * "Depuis quel contexte" — miroir primitif d'`ActorKind`, restreint aux DEUX valeurs pertinentes
 * ici : ce port n'a AUCUN producteur `SYSTEM` (contrairement a `ProvisioningAuditTrail`) —
 * `RenameHealthFacilityHandler` n'est invoque que depuis une route HTTP authentifiee, jamais un
 * consommateur Outbox.
 */
export type TenantConfigActorKind = 'USER_TENANT' | 'USER_PLATFORM';

export interface TenantConfigAuditRecordInput {
  readonly eventType: TenantConfigAuditEventType;
  readonly outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  /** `null` uniquement pour un refus depuis une session `PLATFORM` (structurellement sans tenant, voir `TenantConfigPrincipal.ts`). */
  readonly tenantId: string | null;
  readonly actorKind: TenantConfigActorKind;
  readonly actorUserId: string;
  readonly actorRoleCodes: readonly string[];
  /** Cible fixee a `HEALTH_FACILITY` par l'adaptateur (composition-root.ts) — jamais transmise ici, ce port n'a qu'une seule cible possible. */
  readonly targetId: string | null;
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
}

/**
 * Port sortant de `tenant` vers le module `audit` (meme discipline qu'ADR-0009 §2.2/§4 —
 * `ProvisioningAuditTrail`). L'implementation reelle est cablee dans `composition-root.ts` (seul
 * point du code autorise a connaitre les deux modules).
 *
 * NON NEGOCIABLE (ADR-0005 Amendement 3, meme convention que `ApproveSuperAdminBreakGlass.ts`) :
 * `record()` DOIT etre appele DANS LA TRANSACTION COURANTE (via `resolvePrismaClient`), y compris
 * pour un refus d'autorisation (`outcome: 'DENIED'`) — un `Result.failure` ne doit JAMAIS lancer
 * d'exception : l'entree d'audit doit committer meme quand la commande echoue globalement. Seule
 * une exception technique annule toute la transaction (et donc l'entree d'audit avec elle).
 */
export interface TenantConfigAuditTrail {
  record(input: TenantConfigAuditRecordInput): Promise<void>;
}
