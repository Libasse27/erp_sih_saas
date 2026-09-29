import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import type { UserTenantMembership } from '../../../src/modules/identity/domain/UserTenantMembership.js';
import type { UserTenantMembershipRepository } from '../../../src/modules/identity/domain/ports/UserTenantMembershipRepository.js';
import { UserAccount } from '../../../src/modules/identity/domain/UserAccount.js';
import { Email } from '../../../src/modules/identity/domain/value-objects/Email.js';
import { PasswordHash } from '../../../src/modules/identity/domain/value-objects/PasswordHash.js';
import type { RoleId } from '../../../src/modules/identity/domain/value-objects/RoleId.js';
import type { UserTenantMembershipId } from '../../../src/modules/identity/domain/value-objects/UserTenantMembershipId.js';
import type { MembershipStatus } from '../../../src/modules/identity/domain/value-objects/MembershipStatus.js';
import type { MembershipPageRequest, UserTenantMembershipPage } from '../../../src/modules/identity/domain/MembershipPage.js';
import { GrantMembershipHandler } from '../../../src/modules/identity/application/commands/GrantMembership.js';
import { PrismaUserAccountRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserAccountRepository.js';
import { PrismaRoleRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaRoleRepository.js';
import { PrismaUserTenantMembershipRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserTenantMembershipRepository.js';
import { InMemoryMembershipAuditTrail } from '../builders/testKit.js';
import { createRawPgClient, createTestPrismaClient } from './dbTestHelpers.js';

describe('PrismaUserTenantMembershipRepository.lockTenantForAdminRecovery — verrou advisory PostgreSQL', () => {
  let prisma: PrismaClient;
  let rawClient: Client;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
  });

  afterAll(async () => {
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('sérialise deux transactions distinctes visant le même tenant et libère le verrou au commit', async () => {
    const tenantId = TenantId.create(randomUUID()).getValue();
    const unitOfWork = new PgUnitOfWork(prisma);
    const repository = new PrismaUserTenantMembershipRepository(prisma, new SystemClock(), new UuidGenerator());
    let signalLockAcquired!: () => void;
    let releaseTransaction!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { signalLockAcquired = resolve; });
    const holdTransaction = new Promise<void>((resolve) => { releaseTransaction = resolve; });

    const firstTransaction = unitOfWork.withTransaction(async () => {
      await repository.lockTenantForAdminRecovery(tenantId);
      signalLockAcquired();
      await holdTransaction;
    });

    await lockAcquired;
    try {
      const whileHeld = await rawClient.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext('tenant-admin-recovery'), hashtext($1)) AS acquired`,
        [tenantId.toString()],
      );
      expect(whileHeld.rows[0]?.acquired).toBe(false);
    } finally {
      releaseTransaction();
      await firstTransaction;
    }

    const afterCommit = await rawClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('tenant-admin-recovery'), hashtext($1)) AS acquired`,
      [tenantId.toString()],
    );
    expect(afterCommit.rows[0]?.acquired).toBe(true);
  });
});

/**
 * Course fermee suite a revue : `GrantMembershipHandler` (chemin du provisioning initial /
 * redelivrance Outbox de `subscription.subscription.started`, voir
 * `GrantOwnerMembershipOnSubscriptionStarted.ts`) peut aussi attribuer `ADMIN_ETABLISSEMENT` —
 * sans le MEME verrou que `ApproveTenantAdminRecoveryHandler`, les deux chemins pourraient
 * s'executer en parallele sur un tenant qui vient de perdre son seul admin, chacun lisant "aucun
 * admin actif" avant que l'autre ne commite. Ce test prouve que `GrantMembershipHandler` prend
 * REELLEMENT le meme verrou advisory (namespace `'tenant-admin-recovery'`) AVANT sa mutation,
 * pas seulement `ApproveTenantAdminRecoveryHandler` isolement — via un repository de test qui
 * retarde `save()` pour observer l'etat du verrou pendant que la transaction d'octroi est encore
 * ouverte.
 */
describe('GrantMembershipHandler — partage le meme verrou advisory que la recuperation quand le role porte membership:administer', () => {
  let prisma: PrismaClient;
  let rawClient: Client;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
  });

  afterAll(async () => {
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('bloque une tentative concurrente de verrouillage du meme tenant tant que la transaction d_octroi ADMIN_ETABLISSEMENT n_a pas commite', async () => {
    const tenantId = TenantId.create(randomUUID()).getValue();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const accounts = new PrismaUserAccountRepository(prisma);
    const roles = new PrismaRoleRepository(prisma);
    const audit = new InMemoryMembershipAuditTrail();
    const unitOfWork = new PgUnitOfWork(prisma);
    const realMemberships = new PrismaUserTenantMembershipRepository(prisma, clock, idGenerator);

    const beneficiary = UserAccount.register({
      email: Email.create(`recovery-race-${randomUUID()}@hopital-test.sn`).getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(beneficiary);

    let releaseSave!: () => void;
    const holdSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let signalSaveReached!: () => void;
    const saveReached = new Promise<void>((resolve) => {
      signalSaveReached = resolve;
    });

    // Delegue tout au repository REEL, sauf `save()` : retarde jusqu'a `holdSave`, pour laisser
    // le temps au test d'observer l'etat du verrou pendant que la transaction d'octroi est
    // toujours ouverte (meme technique que le test precedent, mais via le VRAI handler plutot
    // qu'un appel direct au repository).
    class DelayedSaveMembershipRepository implements UserTenantMembershipRepository {
      findActiveByUserAndTenant(userId: UserAccountId, tid: TenantId): Promise<UserTenantMembership | null> {
        return realMemberships.findActiveByUserAndTenant(userId, tid);
      }
      findById(id: UserTenantMembershipId, tid: TenantId): Promise<UserTenantMembership | null> {
        return realMemberships.findById(id, tid);
      }
      lockTenantForAdminRecovery(tid: TenantId): Promise<void> {
        return realMemberships.lockTenantForAdminRecovery(tid);
      }
      listActiveTenantIdsForUser(userId: UserAccountId): Promise<readonly TenantId[]> {
        return realMemberships.listActiveTenantIdsForUser(userId);
      }
      countActive(tid: TenantId): Promise<number> {
        return realMemberships.countActive(tid);
      }
      listActiveByTenantAndRole(tid: TenantId, roleId: RoleId): Promise<readonly UserTenantMembership[]> {
        return realMemberships.listActiveByTenantAndRole(tid, roleId);
      }
      listByTenant(
        tid: TenantId,
        filter: { readonly status?: MembershipStatus },
        page: MembershipPageRequest,
      ): Promise<UserTenantMembershipPage> {
        return realMemberships.listByTenant(tid, filter, page);
      }
      async save(membership: UserTenantMembership, tid: TenantId): Promise<void> {
        signalSaveReached();
        await holdSave;
        return realMemberships.save(membership, tid);
      }
    }

    const handler = new GrantMembershipHandler(
      accounts,
      new DelayedSaveMembershipRepository(),
      roles,
      unitOfWork,
      clock,
      idGenerator,
      audit,
    );

    const grantPromise = handler.execute({
      userId: beneficiary.id.toString(),
      tenantId: tenantId.toString(),
      createdBy: beneficiary.id.toString(),
      initialRoleCodes: ['ADMIN_ETABLISSEMENT'],
    });

    await saveReached;
    try {
      // Le verrou est pris AVANT `findActiveByUserAndTenant`/`save()` (voir GrantMembership.ts) :
      // s'il est deja tenu ici, c'est la preuve que `GrantMembershipHandler` l'a bien acquis,
      // pas seulement `ApproveTenantAdminRecoveryHandler`.
      const whileHeld = await rawClient.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext('tenant-admin-recovery'), hashtext($1)) AS acquired`,
        [tenantId.toString()],
      );
      expect(whileHeld.rows[0]?.acquired).toBe(false);
    } finally {
      releaseSave();
    }

    const result = await grantPromise;
    expect(result.isSuccess()).toBe(true);

    const afterCommit = await rawClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('tenant-admin-recovery'), hashtext($1)) AS acquired`,
      [tenantId.toString()],
    );
    expect(afterCommit.rows[0]?.acquired).toBe(true);
  });

  it("ne prend PAS le verrou pour un role qui ne porte pas membership:administer (aucun cout pour l'octroi ordinaire)", async () => {
    const tenantId = TenantId.create(randomUUID()).getValue();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const accounts = new PrismaUserAccountRepository(prisma);
    const roles = new PrismaRoleRepository(prisma);
    const memberships = new PrismaUserTenantMembershipRepository(prisma, clock, idGenerator);
    const audit = new InMemoryMembershipAuditTrail();
    const unitOfWork = new PgUnitOfWork(prisma);
    const handler = new GrantMembershipHandler(accounts, memberships, roles, unitOfWork, clock, idGenerator, audit);

    const account = UserAccount.register({
      email: Email.create(`no-admin-role-${randomUUID()}@hopital-test.sn`).getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(account);

    const result = await handler.execute({
      userId: account.id.toString(),
      tenantId: tenantId.toString(),
      createdBy: account.id.toString(),
      initialRoleCodes: ['MEDECIN'],
    });

    expect(result.isSuccess()).toBe(true);
    // Le verrou n'a jamais ete pris pour ce tenant : toujours disponible immediatement.
    const stillAvailable = await rawClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('tenant-admin-recovery'), hashtext($1)) AS acquired`,
      [tenantId.toString()],
    );
    expect(stillAvailable.rows[0]?.acquired).toBe(true);
  });
});
