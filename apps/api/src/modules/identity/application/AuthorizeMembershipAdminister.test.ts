import { describe, expect, it } from 'vitest';
import { uuidAt } from '../../../../test/identity/builders/testKit.js';
import { authorizeMembershipAdminister } from './AuthorizeMembershipAdminister.js';
import type { MembershipAdminPrincipal } from './MembershipAdminPrincipal.js';

const TENANT_ID = uuidAt(1);
const ACTOR_ID = uuidAt(2);

describe('authorizeMembershipAdminister', () => {
  it('autorise une session TENANT portant membership:administer', () => {
    const principal: MembershipAdminPrincipal = {
      kind: 'TENANT',
      actorUserId: ACTOR_ID,
      tenantId: TENANT_ID,
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['membership:administer', 'audit:read'],
    };

    const result = authorizeMembershipAdminister(principal);

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue()).toEqual({ tenantId: TENANT_ID, actorUserId: ACTOR_ID, roleCodes: ['ADMIN_ETABLISSEMENT'] });
  });

  it('refuse (FORBIDDEN) une session TENANT SANS membership:administer', () => {
    const principal: MembershipAdminPrincipal = {
      kind: 'TENANT',
      actorUserId: ACTOR_ID,
      tenantId: TENANT_ID,
      roleCodes: ['CAISSIER'],
      permissionCodes: ['cash-register:open'],
    };

    const result = authorizeMembershipAdminister(principal);

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });

  it('refuse EXPLICITEMENT (FORBIDDEN) une session PLATFORM — branche nommee, jamais un fallthrough', () => {
    const principal: MembershipAdminPrincipal = { kind: 'PLATFORM', actorUserId: ACTOR_ID };

    const result = authorizeMembershipAdminister(principal);

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });
});
