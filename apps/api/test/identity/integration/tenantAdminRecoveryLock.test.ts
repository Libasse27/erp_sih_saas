import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { PrismaUserTenantMembershipRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserTenantMembershipRepository.js';
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
