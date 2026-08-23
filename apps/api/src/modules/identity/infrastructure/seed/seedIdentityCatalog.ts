import type { PrismaClient } from '@prisma/client';
import type { RoleRepository } from '../../domain/ports/RoleRepository.js';
import { Role } from '../../domain/Role.js';
import { PERMISSION_CATALOG_CODES, SYSTEM_ROLE_CATALOG } from '../../domain/SystemRoleCatalog.js';
import { Permission } from '../../domain/value-objects/Permission.js';
import { RoleId } from '../../domain/value-objects/RoleId.js';
import { assertValid } from '../persistence/assertValid.js';

/** Seed du catalogue de permissions (niveau plateforme, table `platform.Permission`). Idempotent. */
export async function seedPermissionCatalog(prisma: PrismaClient): Promise<void> {
  for (const code of PERMISSION_CATALOG_CODES) {
    const permission = assertValid(Permission.create(code));
    await prisma.permission.upsert({
      where: { code: permission.code },
      create: { code: permission.code, resource: permission.resource, action: permission.action },
      update: {},
    });
  }
}

/** Seed des 18 roles systeme (catalogue global immuable — voir domain/SystemRoleCatalog.ts). Idempotent. */
export async function seedSystemRoles(roleRepository: RoleRepository): Promise<void> {
  for (const definition of SYSTEM_ROLE_CATALOG) {
    const id = assertValid(RoleId.create(definition.id));
    const permissions = definition.permissionCodes.map((code) => assertValid(Permission.create(code)));
    const role = Role.system({ id, code: definition.code, name: definition.name, permissions });
    await roleRepository.saveSystemRole(role);
  }
}
