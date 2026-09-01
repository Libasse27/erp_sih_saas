import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../identity/builders/testKit.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { buildAuditModule, type AuditModule } from '../../../src/modules/audit/infrastructure/AuditModule.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Immuabilite de `platform.AuditEntry` (ADR-0005 §5, O-04.7, etendue ADR-0009 §5.3 — etape
 * 11/13) — verifiee avec le role applicatif REEL `sih_app` (non-superuser, celui que
 * l'application utilise a l'execution), jamais le role `sih` (superuser) qui contournerait
 * silencieusement le test (meme discipline que test/tenant/integration/rlsGuard.test.ts).
 *
 * Le dernier bloc ("insertion sans entry_hash") verifie la DEUXIEME defense independante du
 * chainage (§5.3) : le trigger `BEFORE INSERT` `audit_entry_requires_hash` — inchange par rapport
 * au reste de ce fichier (role `sih_app`, jamais `sih`).
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
      actorKind: 'USER_PLATFORM',
      subjectUserId,
      actorUserId: subjectUserId,
      actorRoleCodes: [],
      targetType: 'USER_ACCOUNT',
      targetId: subjectUserId,
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

  it(
    "une INSERTION directe SANS entry_hash (role applicatif sih_app) est rejetee par le trigger BEFORE INSERT " +
      '`audit_entry_requires_hash` (ADR-0009 §5.3 — deuxieme defense independante du chainage)',
    async () => {
      const subjectUserId = uniqueId();
      await expect(
        rawClient.query(
          `INSERT INTO "platform"."AuditEntry"
             (id, category, event_type, outcome, tenant_id, actor_kind, actor_user_id, actor_role_codes,
              subject_user_id, target_type, target_id, reason, session_id, correlation_id, occurred_at, entry_hash)
           VALUES
             ($1::uuid, 'MFA', 'MFA_CHALLENGE_SUCCEEDED', 'SUCCESS', NULL, 'USER_PLATFORM', $2::uuid, '{}',
              $2::uuid, 'USER_ACCOUNT', $2::text, NULL, NULL, NULL, now(), NULL)`,
          [uniqueId(), subjectUserId],
        ),
      ).rejects.toThrow(/entry_hash obligatoire|chainage/i);

      const row = await prisma.auditEntry.findFirst({ where: { subjectUserId } });
      expect(row).toBeNull();
    },
  );
});
