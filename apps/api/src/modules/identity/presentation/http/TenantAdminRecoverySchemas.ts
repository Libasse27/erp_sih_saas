import { z } from 'zod';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RequestTenantAdminRecoveryBodySchema = z.object({
  tenantId: z.string().regex(UUID_V4_PATTERN),
  beneficiaryUserId: z.string().regex(UUID_V4_PATTERN),
  reason: z.string().min(1).max(500),
}).strict();

export const ApproveTenantAdminRecoveryBodySchema = z.object({}).strict();

export const TenantAdminRecoveryRequestIdParamSchema = z.object({
  requestId: z.string().regex(UUID_V4_PATTERN),
}).strict();
