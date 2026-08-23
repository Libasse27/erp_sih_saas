import { describe, expect, it } from 'vitest';
import { idFor } from '../../../../../test/identity/builders/testKit.js';
import { Role } from '../Role.js';
import { Permission } from '../value-objects/Permission.js';
import { requiresMfaForMembership, requiresMfaForPlatformContext } from './MfaPolicy.js';

function permission(code: string): Permission {
  const result = Permission.create(code);
  if (result.isFailure()) throw result.getError();
  return result.getValue();
}

describe('MfaPolicy', () => {
  it('requiresMfaForPlatformContext est toujours vrai (plancher structurel SUPER_ADMIN)', () => {
    expect(requiresMfaForPlatformContext()).toBe(true);
  });

  it('un membership sans role sensible ne requiert pas le MFA', () => {
    const role = Role.system({
      id: idFor.role(1),
      code: 'MEDECIN',
      name: 'Medecin',
      permissions: [permission('patient:read')],
    });
    expect(requiresMfaForMembership([role])).toBe(false);
  });

  it('requiresMfaForMembership retourne vrai des qu_UN SEUL role du membership l_exige (le plus restrictif l_emporte)', () => {
    const roleSansMfa = Role.system({
      id: idFor.role(2),
      code: 'INFIRMIER',
      name: 'Infirmier',
      permissions: [permission('patient:read')],
    });
    const roleAvecMfa = Role.system({
      id: idFor.role(3),
      code: 'ADMIN_ETABLISSEMENT',
      name: 'Admin',
      permissions: [permission('membership:administer')],
    });

    expect(requiresMfaForMembership([roleSansMfa, roleAvecMfa])).toBe(true);
    // Le cumul avec un role non sensible ne permet jamais de contourner l'obligation.
    expect(requiresMfaForMembership([roleAvecMfa, roleSansMfa])).toBe(true);
  });

  it('une permission financiere a fort impact declenche aussi le MFA', () => {
    const role = Role.system({
      id: idFor.role(4),
      code: 'RESPONSABLE_FACTURATION',
      name: 'Facturation',
      permissions: [permission('invoice:read'), permission('invoice:cancel')],
    });
    expect(requiresMfaForMembership([role])).toBe(true);
  });
});
