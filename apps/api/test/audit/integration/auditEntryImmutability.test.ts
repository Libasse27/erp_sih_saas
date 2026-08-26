import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../identity/builders/testKit.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { buildAuditModule, type AuditModule } from '../../../src/modules/audit/infrastructure/AuditModule.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Immuabilite de `platform.AuditEntry` (ADR-0005 §5, O-04.7) — verifiee avec le role applicatif
 * REEL `sih_app` (non-superuser, celui que l'application utilise a l'execution), jamais le role
 * `sih` (superuser) qui contournerait silencieusement le test (meme discipline que
 * test/tenant/integration/rlsGuard.test.ts).
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('platform.AuditEntry — append-only (REVOKE UPDATE/DELETE + trigger)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let audit: AuditModule;
  let entryId: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    audit = buildAuditModule({ prisma, clock: new FixedClock('2026-08-26T10:00:00Z'), idGenerator: new UuidGenerator() });

    const subjectUserId = uniqueId();
    await audit.services.recordEntry({
      category: 'MFA',
      eventType: 'MFA_CHALLENGE_SUCCEEDED',
      outcome: 'SUCCESS',
      tenantId: null,
      subjectUserId,
      actorUserId: subjectUserId,
      actorRoleCodes: [],
      reason: null,
      sessionId: null,
      correlationId: null,
    });
    const row = await prisma.auditEntry.findFirst({ where: { subjectUserId }, orderBy: { createdAt: 'desc' } });
    if (row === null) {
      throw new Error("AuditEntry introuvable juste apres son ecriture (bug de test).");
    }
    entryId = row.id;
  });

  afterAll(async () => {
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('un UPDATE direct (role applicatif sih_app) est rejete', async () => {
    await expect(
      rawClient.query('UPDATE "platform"."AuditEntry" SET outcome = $1 WHERE id = $2', ['FAILURE', entryId]),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('un DELETE direct (role applicatif sih_app) est rejete', async () => {
    await expect(rawClient.query('DELETE FROM "platform"."AuditEntry" WHERE id = $1', [entryId])).rejects.toThrow(
      /append-only|permission denied/i,
    );
  });

  it('un TRUNCATE direct (role applicatif sih_app) est rejete (F-8 : REVOKE TRUNCATE + trigger BEFORE TRUNCATE)', async () => {
    await expect(rawClient.query('TRUNCATE TABLE "platform"."AuditEntry"')).rejects.toThrow(/append-only|permission denied/i);
  });

  it("la ligne existe TOUJOURS et est INCHANGEE apres les tentatives ci-dessus", async () => {
    const row = await prisma.auditEntry.findUnique({ where: { id: entryId } });
    expect(row).not.toBeNull();
    expect(row?.outcome).toBe('SUCCESS');
  });
});
