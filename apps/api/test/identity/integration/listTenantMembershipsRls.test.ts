import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { UserAccount } from '../../../src/modules/identity/domain/UserAccount.js';
import { UserTenantMembership } from '../../../src/modules/identity/domain/UserTenantMembership.js';
import { Email } from '../../../src/modules/identity/domain/value-objects/Email.js';
import { PasswordHash } from '../../../src/modules/identity/domain/value-objects/PasswordHash.js';
import type { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { PrismaUserAccountRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserAccountRepository.js';
import { PrismaUserTenantMembershipRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserTenantMembershipRepository.js';
import { PrismaRoleRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaRoleRepository.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import { ListTenantMembershipsHandler } from '../../../src/modules/identity/application/queries/ListTenantMemberships.js';
import type { MembershipAdminPrincipal } from '../../../src/modules/identity/application/MembershipAdminPrincipal.js';
import { createRawPgClient, createTestPrismaClient, uniqueEmail } from './dbTestHelpers.js';

function tenantPrincipal(tenantId: string, actorUserId: string): MembershipAdminPrincipal {
  return { kind: 'TENANT', actorUserId, tenantId, roleCodes: ['ADMIN_ETABLISSEMENT'], permissionCodes: ['membership:administer'] };
}

/**
 * Preuve d'isolation inter-tenant REELLE (PostgreSQL RLS FORCE, pas seulement l'application) pour
 * `ListTenantMembershipsHandler` — Phase 1, deuxieme increment vertical. Complementaire de
 * `rls.test.ts` (qui prouve la meme isolation au niveau SQL brut / repository seul, generiquement
 * pour `UserTenantMembership`) et de `renameHealthFacilityRls.test.ts` (meme discipline, module
 * `tenant`, pour une lecture PAR IDENTIFIANT) : ce fichier exerce la TRANCHE VERTICALE complete
 * (handler -> `PrismaUserTenantMembershipRepository`/`PrismaUserAccountRepository`/
 * `PrismaRoleRepository` -> RLS) specifiquement pour une LISTE.
 *
 * Design NOTABLE : `ListTenantMembershipsQuery` n'expose STRUCTURELLEMENT aucun champ `tenantId`
 * — le tenant cible est TOUJOURS derive de `principal` (lui-meme issu du `ServerContext` serveur,
 * jamais du client). La preuve porte donc ici sur DEUX proprietes distinctes : (1) meme en
 * "forgeant" un appel REPOSITORY direct sur le tenant B alors que le contexte RLS de la
 * transaction est celui du tenant A, RLS bloque et renvoie zero ligne (jamais l'application) ; (2)
 * le handler complet, invoque avec un principal de chaque tenant, ne retourne jamais que SES
 * PROPRES memberships.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('ListTenantMembershipsHandler — isolation inter-tenant reelle (RLS FORCE)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let userAccounts: PrismaUserAccountRepository;
  let memberships: PrismaUserTenantMembershipRepository;
  let roles: PrismaRoleRepository;
  let unitOfWork: PgUnitOfWork;
  let tenantA: TenantId;
  let tenantB: TenantId;
  let userAId: UserAccountId;
  let userBId: UserAccountId;
  const userIdsToCleanup: string[] = [];

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    userAccounts = new PrismaUserAccountRepository(prisma);
    memberships = new PrismaUserTenantMembershipRepository(prisma, clock, idGenerator);
    roles = new PrismaRoleRepository(prisma);
    unitOfWork = new PgUnitOfWork(prisma);

    await seedPermissionCatalog(prisma);
    await seedSystemRoles(roles);

    tenantA = TenantId.create(randomUUID()).getValue();
    tenantB = TenantId.create(randomUUID()).getValue();

    async function seedMember(emailPrefix: string, tenant: TenantId, roleCode: string): Promise<UserAccountId> {
      const account = UserAccount.register({
        email: Email.create(uniqueEmail(emailPrefix)).getValue(),
        passwordHash: PasswordHash.fromHash('hash').getValue(),
        platformRole: 'NONE',
        clock,
        idGenerator,
      });
      await userAccounts.save(account);
      userIdsToCleanup.push(account.id.toString());

      const role = await roles.findSystemRoleByCode(roleCode);
      if (role === null) {
        throw new Error(`setup: role systeme introuvable pour le seed de test : ${roleCode}`);
      }
      const membership = UserTenantMembership.grant({
        userId: account.id,
        tenantId: tenant,
        createdBy: account.id,
        initialRoleIds: [role.id],
        clock,
        idGenerator,
      });
      // `UserTenantMembership` (schema public) est RLS FORCE : l'ecriture doit passer par
      // `UnitOfWork.withTransaction(..., { tenantId })` pour que `app.tenant_id` soit positionne
      // (meme discipline que mfaTenantIsolation.test.ts).
      await unitOfWork.withTransaction(() => memberships.save(membership, tenant), { tenantId: tenant });
      return account.id;
    }

    userAId = await seedMember('membership-rls-a', tenantA, 'MEDECIN');
    userBId = await seedMember('membership-rls-b', tenantB, 'CAISSIER');
  });

  afterAll(async () => {
    for (const tenant of [tenantA, tenantB]) {
      await rawClient.query('BEGIN');
      await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.toString()]);
      await rawClient.query('DELETE FROM "MembershipRole" WHERE tenant_id = $1', [tenant.toString()]);
      await rawClient.query('DELETE FROM "UserTenantMembership" WHERE tenant_id = $1', [tenant.toString()]);
      await rawClient.query('COMMIT');
    }
    if (userIdsToCleanup.length > 0) {
      await rawClient.query('DELETE FROM "platform"."UserAccount" WHERE id = ANY($1)', [userIdsToCleanup]);
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  function realHandler(): ListTenantMembershipsHandler {
    return new ListTenantMembershipsHandler(memberships, userAccounts, roles, unitOfWork);
  }

  it(
    'le repository, interroge SOUS le contexte RLS du tenant A pour le tenant B (appel "force"), ne renvoie AUCUNE ligne : ' +
      'RLS bloque, jamais l_application',
    async () => {
      const crossTenantRead = await unitOfWork.withTransaction(
        () => memberships.listByTenant(tenantB, {}, { cursor: null, limit: 50 }),
        { tenantId: tenantA },
      );
      expect(crossTenantRead.memberships).toHaveLength(0);
      expect(crossTenantRead.nextCursor).toBeNull();
    },
  );

  it('le handler, invoque avec un principal du tenant A, ne retourne JAMAIS les memberships du tenant B', async () => {
    const result = await realHandler().execute({
      principal: tenantPrincipal(tenantA.toString(), randomUUID()),
      cursor: null,
      limit: 50,
    });

    expect(result.isSuccess()).toBe(true);
    const page = result.getValue();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.userId).toBe(userAId.toString());
    expect(page.items[0]?.roleCodes).toEqual(['MEDECIN']);
    expect(page.items.some((item) => item.userId === userBId.toString())).toBe(false);
  });

  it('symetriquement, un principal du tenant B ne voit jamais le membership du tenant A', async () => {
    const result = await realHandler().execute({
      principal: tenantPrincipal(tenantB.toString(), randomUUID()),
      cursor: null,
      limit: 50,
    });

    expect(result.isSuccess()).toBe(true);
    const page = result.getValue();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.userId).toBe(userBId.toString());
    expect(page.items[0]?.roleCodes).toEqual(['CAISSIER']);
    expect(page.items.some((item) => item.userId === userAId.toString())).toBe(false);
  });
});
