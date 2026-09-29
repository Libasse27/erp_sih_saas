import { describe, expect, it } from 'vitest';
import { ListAuditEntriesQuerySchema } from './ListAuditEntriesQuerySchema.js';

describe('ListAuditEntriesQuerySchema', () => {
  it.each(['TENANT_ADMIN_RECOVERY_REQUESTED', 'TENANT_ADMIN_RECOVERY_APPROVED'])(
    'accepte le filtre eventType=%s',
    (eventType) => {
      expect(ListAuditEntriesQuerySchema.safeParse({ eventType }).success).toBe(true);
    },
  );
});
