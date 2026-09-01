import { z } from 'zod';

const CATEGORY_VALUES = ['MFA', 'SESSION', 'PROVISIONING', 'MEMBERSHIP', 'SUBSCRIPTION', 'BILLING', 'AUDIT_ACCESS'] as const;

const OUTCOME_VALUES = ['SUCCESS', 'FAILURE', 'DENIED'] as const;

const ACTOR_KIND_VALUES = ['USER_TENANT', 'USER_PLATFORM', 'SYSTEM'] as const;

const TARGET_TYPE_VALUES = [
  'USER_ACCOUNT',
  'MEMBERSHIP',
  'HEALTH_FACILITY',
  'SUBSCRIPTION',
  'PAYMENT',
  'PLATFORM_INVOICE',
  'FACILITY_SETTINGS',
  'AUDIT_TRAIL',
] as const;

const EVENT_TYPE_VALUES = [
  'MFA_ENROLLMENT_STARTED',
  'MFA_ENROLLMENT_CONFIRMED',
  'MFA_FACTOR_REPLACED',
  'MFA_CHALLENGE_SUCCEEDED',
  'MFA_CHALLENGE_FAILED',
  'MFA_CHALLENGE_BLOCKED',
  'MFA_BYPASS_ATTEMPTED',
  'MFA_RECOVERY_CODE_CONSUMED',
  'MFA_RECOVERY_CODES_EXHAUSTED',
  'MFA_RECOVERY_CODES_REGENERATED',
  'MFA_RE_ENROLLMENT_FORCED',
  'MFA_FACTOR_LOCKED_OUT',
  'SESSION_REFRESH_ROTATED',
  'SESSION_REFRESH_REUSE_DETECTED',
  'SESSION_REFRESH_REVOKED',
  'SESSION_ABSOLUTE_CEILING_EXCEEDED',
  'SESSION_INACTIVITY_TIMEOUT',
  'SESSION_LOGIN_SUCCEEDED',
  'SESSION_LOGIN_FAILED',
  'SESSION_CONTEXT_OPENED',
  'SESSION_CONTEXT_DENIED',
  'SESSION_CLOSED',
  'PROVISIONING_FACILITY_CREATED',
  'PROVISIONING_CONFIGURATION_SEEDED',
  'PROVISIONING_COMPLETED',
  'MEMBERSHIP_GRANTED',
  'MEMBERSHIP_REVOKED',
  'MEMBERSHIP_ROLE_ASSIGNED',
  'MEMBERSHIP_ROLE_UNASSIGNED',
  'SUBSCRIPTION_TRIAL_STARTED',
  'SUBSCRIPTION_PLAN_UPGRADE_REQUESTED',
  'SUBSCRIPTION_PLAN_CHANGED',
  'SUBSCRIPTION_RENEWED',
  'SUBSCRIPTION_GRACE_PERIOD_STARTED',
  'SUBSCRIPTION_DEGRADED_MODE_ENTERED',
  'SUBSCRIPTION_DEGRADED_MODE_SUSTAINED',
  'SUBSCRIPTION_REACTIVATED',
  'BILLING_PAYMENT_INITIATED',
  'BILLING_PAYMENT_CONFIRMED',
  'BILLING_PLATFORM_INVOICE_ISSUED',
  'BILLING_PLATFORM_INVOICE_SETTLED',
  'AUDIT_TRAIL_QUERIED',
  'AUDIT_TRAIL_QUERY_DENIED',
] as const;

/**
 * Validation `.strict()` (regle §7.3 du system prompt : rejet des champs inconnus, anti mass-
 * assignment) de `GET /api/v1/audit-entries` (ADR-0009 §8). `limit` borne 1..200 — un depassement
 * est un REJET explicite (`INVALID_QUERY` -> 400), jamais un plafonnement silencieux (§6).
 */
export const ListAuditEntriesQuerySchema = z
  .object({
    category: z.enum(CATEGORY_VALUES).optional(),
    eventType: z.enum(EVENT_TYPE_VALUES).optional(),
    outcome: z.enum(OUTCOME_VALUES).optional(),
    actorKind: z.enum(ACTOR_KIND_VALUES).optional(),
    actorUserId: z.string().uuid().optional(),
    subjectUserId: z.string().uuid().optional(),
    targetType: z.enum(TARGET_TYPE_VALUES).optional(),
    targetId: z.string().min(1).max(200).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    cursor: z.string().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    scope: z.enum(['all', 'platform', 'tenant']).optional(),
    tenantId: z.string().uuid().optional(),
  })
  .strict();

export type ListAuditEntriesQueryInput = z.infer<typeof ListAuditEntriesQuerySchema>;
