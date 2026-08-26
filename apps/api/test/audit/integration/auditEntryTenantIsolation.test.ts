import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../identity/builders/testKit.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { AuditEntryId } from '../../../src/modules/audit/domain/value-objects/AuditEntryId.js';
import { buildAuditModule, type AuditModule } from '../../../src/modules/audit/infrastructure/AuditModule.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Isolation inter-tenant de `platform.AuditEntry` (ADR-0005 §5) — calque de
 * test/subscription/integration/subscriptionRepositoryTenantIsolation.test.ts pour une table du
 * schema `platform` SANS RLS : le filtrage `tenant_id` est PUREMENT APPLICATIF, jamais garanti
 * par le moteur. Le premier bloc prouve qu'une requete applicative CORRECTEMENT filtree ne
 * renvoie jamais la ligne d'un autre tenant ; le second bloc prouve, par contraste, qu'une
 * requete SANS filtre applicatif (contournement) expose bel et bien les deux tenants — c'est
 * precisement pourquoi le premier bloc doit exister (voir ADR-0005 §5, alternative ecartee #7).
 *
 * `AuditEntryRepository` (contrat minimal, ADR-0005 §5) n'expose volontairement PAS de methode
 * de liste/recherche par tenant a cette etape (reserve a la console Super Admin, etape 11/13) —
 * ce test construit donc sa propre requete Prisma filtree, exactement comme le fera un futur
 * repository de lecture, pour prouver que le filtrage EST possible et DOIT etre applique par
 * tout appelant.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('AuditEntry — isolation inter-tenant (schema platform, sans RLS)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let audit: AuditModule;

  const tenantAId = uniqueId();
  const tenantBId = uniqueId();
  let subjectAId: string;
  let subjectBId: string;
  let entryAId: string;
  let entryBId: string;
  let platformEntryId: string;
  const platformSubjectId = uniqueId();

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    audit = buildAuditModule({ prisma, clock: new FixedClock('2026-08-26T10:00:00Z'), idGenerator: new UuidGenerator() });

    subjectAId = uniqueId();
    subjectBId = uniqueId();

    await audit.services.recordEntry({
      category: 'MFA',
      eventType: 'MFA_CHALLENGE_SUCCEEDED',
      outcome: 'SUCCESS',
      tenantId: tenantAId,
      subjectUserId: subjectAId,
      actorUserId: subjectAId,
      actorRoleCodes: [],
      reason: null,
      sessionId: null,
      correlationId: null,
    });
    await audit.services.recordEntry({
      category: 'MFA',
      eventType: 'MFA_CHALLENGE_SUCCEEDED',
      outcome: 'SUCCESS',
      tenantId: tenantBId,
      subjectUserId: subjectBId,
      actorUserId: subjectBId,
      actorRoleCodes: [],
      reason: null,
      sessionId: null,
      correlationId: null,
    });
    // Entree PLATEFORME (`tenantId: null`, F-6) : necessaire pour prouver que `findById` filtre
    // aussi explicitement sur `tenant_id IS NULL`, sans jamais ignorer purement et simplement le
    // parametre `tenantId` quand il vaut `null`.
    await audit.services.recordEntry({
      category: 'MFA',
      eventType: 'MFA_CHALLENGE_SUCCEEDED',
      outcome: 'SUCCESS',
      tenantId: null,
      subjectUserId: platformSubjectId,
      actorUserId: platformSubjectId,
      actorRoleCodes: [],
      reason: null,
      sessionId: null,
      correlationId: null,
    });

    const rowA = await prisma.auditEntry.findFirst({ where: { subjectUserId: subjectAId } });
    const rowB = await prisma.auditEntry.findFirst({ where: { subjectUserId: subjectBId } });
    const rowPlatform = await prisma.auditEntry.findFirst({ where: { subjectUserId: platformSubjectId } });
    if (rowA === null || rowB === null || rowPlatform === null) {
      throw new Error('AuditEntry introuvable juste apres son ecriture (bug de test).');
    }
    entryAId = rowA.id;
    entryBId = rowB.id;
    platformEntryId = rowPlatform.id;
  });

  afterAll(async () => {
    await rawClient.end();
    await prisma.$disconnect();
  });

  describe('REQUETE APPLICATIVE FILTREE — ne renvoie jamais la ligne d_un autre tenant', () => {
    it('un filtre tenant_id = tenantA ne renvoie JAMAIS le sujet du tenant B', async () => {
      const rows = await prisma.auditEntry.findMany({ where: { tenantId: tenantAId } });
      const subjectIds = rows.map((row) => row.subjectUserId);
      expect(subjectIds).toContain(subjectAId);
      expect(subjectIds).not.toContain(subjectBId);
    });

    it('un filtre tenant_id = tenantB ne renvoie JAMAIS le sujet du tenant A (symetrique)', async () => {
      const rows = await prisma.auditEntry.findMany({ where: { tenantId: tenantBId } });
      const subjectIds = rows.map((row) => row.subjectUserId);
      expect(subjectIds).toContain(subjectBId);
      expect(subjectIds).not.toContain(subjectAId);
    });
  });

  describe('AuditEntryRepository.findById(id, tenantId) — filtrage tenant OBLIGATOIRE (F-6)', () => {
    it('renvoie l_entree quand le tenantId fourni correspond', async () => {
      const entry = await audit.repositories.auditEntries.findById(
        AuditEntryId.create(entryAId).getValue(),
        TenantId.create(tenantAId).getValue(),
      );
      expect(entry).not.toBeNull();
      expect(entry?.subjectUserId).toBe(subjectAId);
    });

    it('renvoie null quand on demande la ligne du tenant A avec le tenantId du tenant B (isolation)', async () => {
      const entry = await audit.repositories.auditEntries.findById(
        AuditEntryId.create(entryAId).getValue(),
        TenantId.create(tenantBId).getValue(),
      );
      expect(entry).toBeNull();
    });

    it('renvoie null quand on demande la ligne du tenant B avec le tenantId du tenant A (symetrique)', async () => {
      const entry = await audit.repositories.auditEntries.findById(
        AuditEntryId.create(entryBId).getValue(),
        TenantId.create(tenantAId).getValue(),
      );
      expect(entry).toBeNull();
    });

    it('renvoie l_entree PLATEFORME (tenant_id NULL) quand tenantId=null est fourni explicitement', async () => {
      const entry = await audit.repositories.auditEntries.findById(AuditEntryId.create(platformEntryId).getValue(), null);
      expect(entry).not.toBeNull();
      expect(entry?.tenantId).toBeNull();
    });

    it('ne renvoie PAS l_entree PLATEFORME quand un tenantId non-null est fourni (le null n_est jamais ignore)', async () => {
      const entry = await audit.repositories.auditEntries.findById(
        AuditEntryId.create(platformEntryId).getValue(),
        TenantId.create(tenantAId).getValue(),
      );
      expect(entry).toBeNull();
    });

    it('ne renvoie PAS une entree tenant-scopee quand tenantId=null est fourni (le null n_agit pas comme un joker)', async () => {
      const entry = await audit.repositories.auditEntries.findById(AuditEntryId.create(entryAId).getValue(), null);
      expect(entry).toBeNull();
    });
  });

  describe('ABSENCE DE RLS — contraste deliberement demontre (ADR-0005 §5)', () => {
    it('une requete SQL brute SANS filtre tenant_id expose les DEUX tenants (aucun moteur ne bloque)', async () => {
      const result = await rawClient.query('SELECT tenant_id FROM "platform"."AuditEntry" WHERE subject_user_id = ANY($1)', [
        [subjectAId, subjectBId],
      ]);
      const tenantIdsVisible = result.rows.map((row: { tenant_id: string }) => row.tenant_id);
      expect(tenantIdsVisible).toEqual(expect.arrayContaining([tenantAId, tenantBId]));
    });
  });
});
