/**
 * Types d'evenement journalises. Miroir EXACT des unions primitives dupliquees dans chaque port
 * sortant de module producteur (`identity/application/ports/AuditTrail.ts`,
 * `.../SessionAuditTrail.ts`, `.../MembershipAuditTrail.ts`,
 * `tenant/application/ports/ProvisioningAuditTrail.ts`,
 * `subscription/application/ports/SubscriptionAuditTrail.ts`,
 * `payment/application/ports/BillingAuditTrail.ts`) — dupliquation deliberee (un module n'importe
 * jamais le domain/ ni les ports applicatifs d'un autre module) ; `composition-root.ts` est le
 * seul point du code qui traduit de l'une vers l'autre (ADR-0005 §5, ADR-0009 §4).
 */
export type AuditEventType =
  // ===== MFA (ADR-0005 §5-6, O-04.7) =====
  | 'MFA_ENROLLMENT_STARTED'
  | 'MFA_ENROLLMENT_CONFIRMED'
  | 'MFA_FACTOR_REPLACED'
  | 'MFA_CHALLENGE_SUCCEEDED'
  | 'MFA_CHALLENGE_FAILED'
  | 'MFA_CHALLENGE_BLOCKED'
  | 'MFA_BYPASS_ATTEMPTED'
  | 'MFA_RECOVERY_CODE_CONSUMED'
  | 'MFA_RECOVERY_CODES_EXHAUSTED'
  | 'MFA_RECOVERY_CODES_REGENERATED'
  | 'MFA_RE_ENROLLMENT_FORCED'
  | 'MFA_FACTOR_LOCKED_OUT'
  // ===== MFA — break-glass SUPER_ADMIN (ADR-0005 Amendement 1, O-04 residu 4) =====
  | 'SUPER_ADMIN_BREAK_GLASS_REQUESTED'
  | 'SUPER_ADMIN_BREAK_GLASS_APPROVED'
  // ===== SESSION — cycle de vie du refresh token (ADR-0006 §8, etape 8/13) =====
  | 'SESSION_REFRESH_ROTATED'
  | 'SESSION_REFRESH_REUSE_DETECTED'
  | 'SESSION_REFRESH_REVOKED'
  | 'SESSION_ABSOLUTE_CEILING_EXCEEDED'
  | 'SESSION_INACTIVITY_TIMEOUT'
  // ===== SESSION — fermeture de la lacune §Contexte 3 (ADR-0009 §2.1) =====
  | 'SESSION_LOGIN_SUCCEEDED'
  | 'SESSION_LOGIN_FAILED'
  | 'SESSION_CONTEXT_OPENED'
  | 'SESSION_CONTEXT_DENIED'
  | 'SESSION_CLOSED'
  // ===== PROVISIONING (ADR-0009 §2.2, ADR-0008) =====
  | 'PROVISIONING_FACILITY_CREATED'
  | 'PROVISIONING_CONFIGURATION_SEEDED'
  | 'PROVISIONING_COMPLETED'
  // ===== MEMBERSHIP (ADR-0009 §2.2) =====
  | 'MEMBERSHIP_GRANTED'
  | 'MEMBERSHIP_REVOKED'
  // `MEMBERSHIP_ROLE_ASSIGNED`/`MEMBERSHIP_ROLE_UNASSIGNED` : declares au catalogue par l'ADR
  // (§2.2, tableau principal) mais SANS PRODUCTEUR dans ce depot — aucune commande
  // d'assignation/desassignation de role separee de `GrantMembership` n'existe (voir
  // `identity/application/commands/`). Signale au responsable technique (rapport de cette
  // etape) plutot que d'inventer une commande non demandee par ailleurs par l'ADR.
  | 'MEMBERSHIP_ROLE_ASSIGNED'
  | 'MEMBERSHIP_ROLE_UNASSIGNED'
  // ===== SUBSCRIPTION (ADR-0009 §2.2) =====
  | 'SUBSCRIPTION_TRIAL_STARTED'
  | 'SUBSCRIPTION_PLAN_UPGRADE_REQUESTED'
  | 'SUBSCRIPTION_PLAN_CHANGED'
  | 'SUBSCRIPTION_RENEWED'
  | 'SUBSCRIPTION_GRACE_PERIOD_STARTED'
  | 'SUBSCRIPTION_DEGRADED_MODE_ENTERED'
  | 'SUBSCRIPTION_DEGRADED_MODE_SUSTAINED'
  | 'SUBSCRIPTION_REACTIVATED'
  // ===== BILLING (ADR-0009 §2.2) =====
  | 'BILLING_PAYMENT_INITIATED'
  | 'BILLING_PAYMENT_CONFIRMED'
  | 'BILLING_PLATFORM_INVOICE_ISSUED'
  | 'BILLING_PLATFORM_INVOICE_SETTLED'
  // ===== AUDIT_ACCESS (ADR-0009 §7) =====
  | 'AUDIT_TRAIL_QUERIED'
  | 'AUDIT_TRAIL_QUERY_DENIED';
