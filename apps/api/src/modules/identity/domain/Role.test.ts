import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { idFor, uuidAt } from '../../../../test/identity/builders/testKit.js';
import { Role } from './Role.js';
import { Permission } from './value-objects/Permission.js';

const TENANT_A = TenantId.create(uuidAt(2000)).getValue();

function permission(code: string): Permission {
  const result = Permission.create(code);
  if (result.isFailure()) throw result.getError();
  return result.getValue();
}

describe('Role', () => {
  it('system() cree un role de scope SYSTEM sans tenantId', () => {
    const role = Role.system({
      id: idFor.role(1),
      code: 'MEDECIN',
      name: 'Medecin',
      permissions: [permission('patient:read')],
    });

    expect(role.scope).toBe('SYSTEM');
    expect(role.tenantId).toBeNull();
    expect(role.hasPermission(permission('patient:read'))).toBe(true);
  });

  it('custom() accepte un role compose dans les capacites du forfait, sans permission plateforme', () => {
    const allowedByPlan = [permission('patient:read'), permission('patient:write')];
    const role = Role.custom({
      id: idFor.role(2),
      code: 'ACCUEIL_RENFORCE',
      name: "Accueil renforce",
      tenantId: TENANT_A,
      permissions: [permission('patient:read')],
      allowedByPlan,
    });

    expect(role.scope).toBe('TENANT');
    expect(role.tenantId?.equals(TENANT_A)).toBe(true);
  });

  it('custom() rejette une permission de niveau plateforme', () => {
    expect(() =>
      Role.custom({
        id: idFor.role(3),
        code: 'FAUX_ADMIN',
        name: 'Faux admin',
        tenantId: TENANT_A,
        permissions: [permission('tenant:administer')],
        allowedByPlan: [permission('tenant:administer')],
      }),
    ).toThrowError(/niveau plateforme/);
  });

  it('custom() rejette une permission hors des capacites du forfait', () => {
    expect(() =>
      Role.custom({
        id: idFor.role(4),
        code: 'TROP_LARGE',
        name: 'Trop large',
        tenantId: TENANT_A,
        permissions: [permission('invoice:cancel')],
        allowedByPlan: [permission('patient:read')],
      }),
    ).toThrowError(/forfait/);
  });

  it('rejette un role sans aucune permission', () => {
    expect(() =>
      Role.system({ id: idFor.role(5), code: 'VIDE', name: 'Vide', permissions: [] }),
    ).toThrowError(/au moins une permission/);
  });
});
