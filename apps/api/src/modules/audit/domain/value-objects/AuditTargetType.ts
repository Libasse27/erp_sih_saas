/**
 * Nature de la cible d'une action auditee (ADR-0009 §3, B1 — "quoi"). Obligatoire ; `targetId`
 * (sur `AuditEntry`) reste nullable, une consultation du journal (`AUDIT_TRAIL`) n'ayant pas de
 * cible unique.
 */
export type AuditTargetType =
  | 'USER_ACCOUNT'
  | 'MEMBERSHIP'
  | 'HEALTH_FACILITY'
  | 'SUBSCRIPTION'
  | 'PAYMENT'
  | 'PLATFORM_INVOICE'
  | 'FACILITY_SETTINGS'
  | 'AUDIT_TRAIL';
