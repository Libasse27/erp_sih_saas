import { describe, expect, it } from 'vitest';
import { idFor } from '../../../../../test/identity/builders/testKit.js';
import { Role } from '../Role.js';
import { Permission } from '../value-objects/Permission.js';
import { hasEffectivePermission, resolveEffectivePermissions } from './PermissionResolver.js';

function permission(code: string): Permission {
  const result = Permission.create(code);
  if (result.isFailure()) throw result.getError();
  return result.getValue();
}

describe('resolveEffectivePermissions', () => {
  it('un membership avec deux roles simultanes obtient l_union additive de leurs permissions', () => {
    const roleA = Role.system({
      id: idFor.role(1),
      code: 'MEDECIN',
      name: 'Medecin',
      permissions: [permission('patient:read'), permission('prescription:write')],
    });
    const roleB = Role.system({
      id: idFor.role(2),
      code: 'RESPONSABLE_RH',
      name: 'RH',
      permissions: [permission('staff-member:write'), permission('patient:read')],
    });

    const effective = resolveEffectivePermissions([roleA, roleB]);
    const codes = effective.map((permissionItem) => permissionItem.code).sort();

    expect(codes).toEqual(['patient:read', 'prescription:write', 'staff-member:write']);
  });

  it('une permission commune a plusieurs roles n_est comptee qu_une fois (union, pas concatenation)', () => {
    const roleA = Role.system({ id: idFor.role(3), code: 'A', name: 'A', permissions: [permission('patient:read')] });
    const roleB = Role.system({ id: idFor.role(4), code: 'B', name: 'B', permissions: [permission('patient:read')] });

    expect(resolveEffectivePermissions([roleA, roleB])).toHaveLength(1);
  });

  it('hasEffectivePermission verifie la presence dans au moins un role', () => {
    const roleA = Role.system({ id: idFor.role(5), code: 'A', name: 'A', permissions: [permission('patient:read')] });
    expect(hasEffectivePermission([roleA], permission('patient:read'))).toBe(true);
    expect(hasEffectivePermission([roleA], permission('invoice:cancel'))).toBe(false);
  });
});
