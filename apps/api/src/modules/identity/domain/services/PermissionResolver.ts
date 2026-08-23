import type { Permission } from '../value-objects/Permission.js';
import type { Role } from '../Role.js';

/**
 * Resolution des permissions effectives d'un membership (01-target-architecture.md §6.3/§7.2) :
 * **union additive** des permissions de tous les roles portes par le membership. Le catalogue
 * RBAC est purement additif — aucune notion de `deny` a resoudre, l'union n'est jamais
 * ambigue. Un membership avec 3 roles compte pour un seul quota `maxUsers` (regle portee par
 * le repository de membership, pas par ce service) mais ses permissions sont la reunion des
 * trois jeux de permissions.
 */
export function resolveEffectivePermissions(roles: readonly Role[]): readonly Permission[] {
  const byCode = new Map<string, Permission>();
  for (const role of roles) {
    for (const permission of role.permissions) {
      byCode.set(permission.code, permission);
    }
  }
  return [...byCode.values()];
}

export function hasEffectivePermission(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => role.hasPermission(permission));
}
