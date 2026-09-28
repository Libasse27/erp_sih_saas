import { describe, expect, it } from 'vitest';
import { uuidAt } from '../../../../test/tenant/builders/testKit.js';
import { authorizeTenantConfigAdminister } from './AuthorizeTenantConfigAdminister.js';
import type { TenantConfigPrincipal } from './TenantConfigPrincipal.js';

const TENANT_ID = uuidAt(1);
const ACTOR_ID = uuidAt(2);

describe('authorizeTenantConfigAdminister', () => {
  it('autorise une session TENANT portant tenant-config:administer', () => {
    const principal: TenantConfigPrincipal = {
      kind: 'TENANT',
      actorUserId: ACTOR_ID,
      tenantId: TENANT_ID,
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['tenant-config:administer', 'audit:read'],
    };

    const result = authorizeTenantConfigAdminister(principal);

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue()).toEqual({ tenantId: TENANT_ID, actorUserId: ACTOR_ID, roleCodes: ['ADMIN_ETABLISSEMENT'] });
  });

  it('refuse (FORBIDDEN) une session TENANT SANS tenant-config:administer', () => {
    const principal: TenantConfigPrincipal = {
      kind: 'TENANT',
      actorUserId: ACTOR_ID,
      tenantId: TENANT_ID,
      roleCodes: ['CAISSIER'],
      permissionCodes: ['cash-register:open'],
    };

    const result = authorizeTenantConfigAdminister(principal);

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });

  it('refuse EXPLICITEMENT (FORBIDDEN) une session PLATFORM — branche nommee, jamais un fallthrough', () => {
    const principal: TenantConfigPrincipal = { kind: 'PLATFORM', actorUserId: ACTOR_ID };

    const result = authorizeTenantConfigAdminister(principal);

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });
});
