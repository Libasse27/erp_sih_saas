import type { PrismaClient } from '@prisma/client';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { RoleRepository } from '../../domain/ports/RoleRepository.js';
import { Role } from '../../domain/Role.js';
import { Permission } from '../../domain/value-objects/Permission.js';
import { RoleId } from '../../domain/value-objects/RoleId.js';
import type { RoleScope } from '../../domain/value-objects/RoleScope.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';

interface RoleRow {
  id: string;
  code: string;
  name: string;
  scope: string;
  tenantId: string | null;
  permissionCodes: readonly string[];
}

/**
 * Repository `Role`. Le catalogue systeme (`scope: 'SYSTEM'`) est un niveau plateforme, lu quel
 * que soit le contexte de session (voir politique RLS `system_role_catalog_read`). Les roles
 * personnalises sont tenant-scoped ; `findByIds` filtre explicitement sur `(tenantId OU NULL)`
 * en plus du RLS (couche 3, ADR-0001 §3.2).
 */
export class PrismaRoleRepository implements RoleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findSystemRoleByCode(code: string): Promise<Role | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.role.findFirst({ where: { code, scope: 'SYSTEM', tenantId: null } });
    return row === null ? null : this.toDomain(row);
  }

  async findByIds(tenantId: TenantId, ids: readonly RoleId[]): Promise<Role[]> {
    if (ids.length === 0) {
      return [];
    }
    const client = resolvePrismaClient(this.prisma);
    const rows = await client.role.findMany({
      where: {
        id: { in: ids.map((id) => id.toString()) },
        OR: [{ tenantId: tenantId.toString() }, { tenantId: null }],
      },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async saveSystemRole(role: Role): Promise<void> {
    if (role.scope !== 'SYSTEM') {
      throw new Error('saveSystemRole ne peut persister que des roles de scope SYSTEM.');
    }
    const client = resolvePrismaClient(this.prisma);
    await client.role.upsert({
      where: { id: role.id.toString() },
      create: {
        id: role.id.toString(),
        code: role.code,
        name: role.name,
        scope: 'SYSTEM',
        tenantId: null,
        permissionCodes: role.permissions.map((permission) => permission.code),
      },
      update: {
        name: role.name,
        permissionCodes: role.permissions.map((permission) => permission.code),
      },
    });
  }

  private toDomain(row: RoleRow): Role {
    const id = assertValid(RoleId.create(row.id));
    const permissions = row.permissionCodes.map((code) => assertValid(Permission.create(code)));
    const tenantId = row.tenantId === null ? null : assertValid(TenantId.create(row.tenantId));
    return Role.reconstitute(id, {
      code: row.code,
      name: row.name,
      scope: row.scope as RoleScope,
      tenantId,
      permissions,
    });
  }
}
