import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { Role } from '../Role.js';
import type { RoleId } from '../value-objects/RoleId.js';

/**
 * Port de persistance pour `Role`. Le catalogue systeme (`scope: 'SYSTEM'`) est un niveau
 * plateforme (lecture jamais filtree par tenant, immuable — `saveSystemRole` est reserve au
 * script de seed d'infrastructure) ; les roles personnalises (`scope: 'TENANT'`) sont
 * tenant-scoped, RLS FORCE, `tenantId` obligatoire comme partout ailleurs dans ce module.
 */
export interface RoleRepository {
  findSystemRoleByCode(code: string): Promise<Role | null>;

  /** Roles (systeme et/ou personnalises de ce tenant) references par un membership. */
  findByIds(tenantId: TenantId, ids: readonly RoleId[]): Promise<Role[]>;

  saveSystemRole(role: Role): Promise<void>;
}
