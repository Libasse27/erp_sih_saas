import { Entity } from '../../../shared-kernel/domain/Entity.js';
import type { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { Permission } from './value-objects/Permission.js';
import { RoleId } from './value-objects/RoleId.js';
import type { RoleScope } from './value-objects/RoleScope.js';

export class PlatformPermissionOnTenantRoleError extends Error {
  constructor(permissionCode: string) {
    super(
      `Le role personnalise ne peut pas s'attribuer la permission de niveau plateforme ` +
        `"${permissionCode}".`,
    );
    this.name = 'PlatformPermissionOnTenantRoleError';
  }
}

export class PermissionExceedsPlanCapabilitiesError extends Error {
  constructor(permissionCode: string) {
    super(
      `La permission "${permissionCode}" depasse les capacites du forfait de l'etablissement.`,
    );
    this.name = 'PermissionExceedsPlanCapabilitiesError';
  }
}

export class EmptyRolePermissionSetError extends Error {
  constructor() {
    super('Un role doit porter au moins une permission.');
    this.name = 'EmptyRolePermissionSetError';
  }
}

interface RoleProps {
  readonly code: string;
  readonly name: string;
  readonly scope: RoleScope;
  readonly tenantId: TenantId | null;
  readonly permissions: readonly Permission[];
}

/**
 * Role RBAC : role systeme (catalogue global immuable, `scope: 'SYSTEM'`, `tenantId: null`) ou
 * role personnalise par etablissement (`scope: 'TENANT'`, `tenantId` obligatoire).
 * Entite (pas VO) : deux roles portant les memes permissions restent distincts par identite —
 * un etablissement peut avoir deux roles personnalises fonctionnellement identiques.
 */
export class Role extends Entity<RoleId> {
  private props: RoleProps;

  private constructor(id: RoleId, props: RoleProps) {
    super(id);
    this.props = props;
  }

  /** Role du catalogue systeme (18 roles immuables, §7.2). */
  static system(params: { id: RoleId; code: string; name: string; permissions: readonly Permission[] }): Role {
    if (params.permissions.length === 0) {
      throw new EmptyRolePermissionSetError();
    }
    return new Role(params.id, {
      code: params.code,
      name: params.name,
      scope: 'SYSTEM',
      tenantId: null,
      permissions: [...params.permissions],
    });
  }

  /**
   * Role personnalise par etablissement, compose a partir du catalogue de permissions.
   * Invariants imposes (decision d'etape, non negociables) :
   *   - jamais de permission de niveau plateforme (`Permission.isPlatformOnly()`) ;
   *   - jamais de permission hors des capacites du forfait (`allowedByPlan`, fourni par
   *     l'appelant — le module Plan/Subscription n'existe pas encore a cette etape ; le
   *     verrou est deja pose au niveau du domaine pour qu'aucune integration future ne
   *     puisse l'oublier).
   */
  static custom(params: {
    id: RoleId;
    code: string;
    name: string;
    tenantId: TenantId;
    permissions: readonly Permission[];
    allowedByPlan: readonly Permission[];
  }): Role {
    if (params.permissions.length === 0) {
      throw new EmptyRolePermissionSetError();
    }
    const allowedCodes = new Set(params.allowedByPlan.map((permission) => permission.code));
    for (const permission of params.permissions) {
      if (permission.isPlatformOnly()) {
        throw new PlatformPermissionOnTenantRoleError(permission.code);
      }
      if (!allowedCodes.has(permission.code)) {
        throw new PermissionExceedsPlanCapabilitiesError(permission.code);
      }
    }
    return new Role(params.id, {
      code: params.code,
      name: params.name,
      scope: 'TENANT',
      tenantId: params.tenantId,
      permissions: [...params.permissions],
    });
  }

  /** Reconstruction depuis la persistance. */
  static reconstitute(id: RoleId, props: RoleProps): Role {
    return new Role(id, props);
  }

  get code(): string {
    return this.props.code;
  }

  get name(): string {
    return this.props.name;
  }

  get scope(): RoleScope {
    return this.props.scope;
  }

  get tenantId(): TenantId | null {
    return this.props.tenantId;
  }

  get permissions(): readonly Permission[] {
    return this.props.permissions;
  }

  hasPermission(permission: Permission): boolean {
    return this.props.permissions.some((candidate) => candidate.equals(permission));
  }
}
