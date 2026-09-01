import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../identity/builders/testKit.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { AuditEntryId } from '../../../src/modules/audit/domain/value-objects/AuditEntryId.js';
import { decodeAuditEntryCursor } from '../../../src/modules/audit/domain/AuditEntryCursor.js';
import { buildAuditModule, type AuditModule } from '../../../src/modules/audit/infrastructure/AuditModule.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Isolation inter-tenant de `platform.AuditEntry` (ADR-0005 §5, etendue ADR-0009 §6/§10 — etape
 * 11/13) — calque de test/subscription/integration/subscriptionRepositoryTenantIsolation.test.ts
 * pour une table du schema `platform` SANS RLS : le filtrage `tenant_id` est PUREMENT APPLICATIF,
 * jamais garanti par le moteur. Le premier bloc prouve qu'une requete applicative CORRECTEMENT
 * filtree ne renvoie jamais la ligne d'un autre tenant ; le second bloc prouve, par contraste,
 * qu'une requete SANS filtre applicatif (contournement) expose bel et bien les deux tenants —
 * c'est precisement pourquoi le premier bloc doit exister (voir ADR-0005 §5, alternative ecartee
 * #7).
 *
 * `AuditEntryRepository.findById` reste couvert ci-dessous (F-6, inchange). Depuis l'etape 11/13
 * (ADR-0009 §6), le port expose EN PLUS `listForTenant`/`listForPlatform`/`readChainSegment` — le
 * bloc "listForTenant/listForPlatform" ci-dessous exerce ces methodes DIRECTEMENT au niveau
 * REPOSITORY (premier des trois niveaux de garde-fou exiges par ADR-0009 §10 ; les niveaux "query
 * handlers"/"HTTP" sont couverts par auditQueryIsolation.test.ts/auditHttpIsolation.test.ts).
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
  let subjectB2Id: string;
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
      actorKind: 'USER_TENANT',
      subjectUserId: subjectAId,
      actorUserId: subjectAId,
      actorRoleCodes: [],
      targetType: 'USER_ACCOUNT',
      targetId: subjectAId,
      reason: null,
      sessionId: null,
      correlationId: null,
    });
    await audit.services.recordEntry({
      category: 'MFA',
      eventType: 'MFA_CHALLENGE_SUCCEEDED',
      outcome: 'SUCCESS',
      tenantId: tenantBId,
      actorKind: 'USER_TENANT',
      subjectUserId: subjectBId,
      actorUserId: subjectBId,
      actorRoleCodes: [],
      targetType: 'USER_ACCOUNT',
      targetId: subjectBId,
      reason: null,
      sessionId: null,
      correlationId: null,
    });
    // Deuxieme entree du tenant B — necessaire pour pouvoir demander une PAGE (limit=1) et
    // recuperer un `nextCursor` reel (ADR-0009 §6 : "le curseur est une position, jamais une
    // autorisation" — voir le bloc "curseur B rejoue sur A" plus bas).
    subjectB2Id = uniqueId();
    await audit.services.recordEntry({
      category: 'MFA',
      eventType: 'MFA_CHALLENGE_SUCCEEDED',
      outcome: 'SUCCESS',
      tenantId: tenantBId,
      actorKind: 'USER_TENANT',
      subjectUserId: subjectB2Id,
      actorUserId: subjectB2Id,
      actorRoleCodes: [],
      targetType: 'USER_ACCOUNT',
      targetId: subjectB2Id,
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
      actorKind: 'USER_PLATFORM',
      subjectUserId: platformSubjectId,
      actorUserId: platformSubjectId,
      actorRoleCodes: [],
      targetType: 'USER_ACCOUNT',
      targetId: platformSubjectId,
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

  describe('AuditEntryRepository.listForTenant/listForPlatform (ADR-0009 §6/§10 — niveau REPOSITORY)', () => {
    it('listForTenant(A) ne renvoie JAMAIS une ligne de B ni une ligne PLATEFORME', async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const page = await audit.repositories.auditEntries.listForTenant(tenantA, {}, { cursor: null, limit: 50 });
      const subjectIds = page.entries.map((entry) => entry.subjectUserId);
      expect(subjectIds).toContain(subjectAId);
      expect(subjectIds).not.toContain(subjectBId);
      expect(subjectIds).not.toContain(subjectB2Id);
      expect(subjectIds).not.toContain(platformSubjectId);
      expect(page.entries.every((entry) => entry.tenantId === tenantAId)).toBe(true);
    });

    it('listForTenant(B) ne renvoie JAMAIS une ligne de A ni une ligne PLATEFORME (symetrique)', async () => {
      const tenantB = TenantId.create(tenantBId).getValue();
      const page = await audit.repositories.auditEntries.listForTenant(tenantB, {}, { cursor: null, limit: 50 });
      const subjectIds = page.entries.map((entry) => entry.subjectUserId);
      expect(subjectIds).toEqual(expect.arrayContaining([subjectBId, subjectB2Id]));
      expect(subjectIds).not.toContain(subjectAId);
      expect(subjectIds).not.toContain(platformSubjectId);
    });

    // Fenetre temporelle etroite autour du `FixedClock` utilise par `beforeAll` — cette base
    // PostgreSQL est PARTAGEE avec l'ensemble de la suite d'integration (jamais reinitialisee
    // entre fichiers) : sans ce filtre, `limit`/`AUDIT_PAGE_MAX_LIMIT` (200) ne suffirait pas a
    // faire remonter des lignes anciennes noyees sous le volume accumule par les AUTRES tests. Le
    // filtre `occurredFrom`/`occurredTo` est un champ ORDINAIRE d'`AuditEntryFilter` (§6) — son
    // usage ici est un detail d'ISOLATION DE TEST, pas une regle metier.
    const recordedAt = new Date('2026-08-26T10:00:00Z');
    const narrowTimeWindow = { occurredFrom: new Date(recordedAt.getTime() - 1000), occurredTo: new Date(recordedAt.getTime() + 1000) };

    it("listForPlatform({kind:'PLATFORM_ONLY'}) ne renvoie JAMAIS une ligne tenant (A ou B)", async () => {
      const page = await audit.repositories.auditEntries.listForPlatform({ kind: 'PLATFORM_ONLY' }, narrowTimeWindow, {
        cursor: null,
        limit: 200,
      });
      const subjectIds = page.entries.map((entry) => entry.subjectUserId);
      expect(subjectIds).toContain(platformSubjectId);
      expect(subjectIds).not.toContain(subjectAId);
      expect(subjectIds).not.toContain(subjectBId);
      expect(subjectIds).not.toContain(subjectB2Id);
      expect(page.entries.every((entry) => entry.tenantId === null)).toBe(true);
    });

    it("listForPlatform({kind:'ALL'}) voit A, B ET la plateforme (seule methode autorisee a traverser les tenants)", async () => {
      const page = await audit.repositories.auditEntries.listForPlatform({ kind: 'ALL' }, narrowTimeWindow, {
        cursor: null,
        limit: 200,
      });
      const subjectIds = page.entries.map((entry) => entry.subjectUserId);
      expect(subjectIds).toEqual(expect.arrayContaining([subjectAId, subjectBId, subjectB2Id, platformSubjectId]));
    });

    it(
      "un curseur issu d'une page du tenant B, rejoue sur listForTenant(A), ne revele RIEN de B " +
        '("le curseur est une position, jamais une autorisation", ADR-0009 §6 — test dedie explicite)',
      async () => {
        const tenantB = TenantId.create(tenantBId).getValue();
        const tenantA = TenantId.create(tenantAId).getValue();

        // Page 1 de B, volontairement bornee a 1 ligne pour obtenir un `nextCursor` REEL.
        const firstPageOfB = await audit.repositories.auditEntries.listForTenant(tenantB, {}, { cursor: null, limit: 1 });
        expect(firstPageOfB.nextCursor).not.toBeNull();
        const decoded = decodeAuditEntryCursor(firstPageOfB.nextCursor as string);
        expect(decoded).not.toBeNull();
        const cursorFromB = { occurredAt: new Date((decoded as NonNullable<typeof decoded>).occurredAt), id: (decoded as NonNullable<typeof decoded>).id };

        // Rejoue du MEME curseur (opaque, sans information de perimetre) sur le tenant A : le
        // filtre `tenantId = A` est TOUJOURS reapplique EN PLUS du curseur — aucune ligne de B ne
        // peut donc jamais apparaitre, quelle que soit la position que le curseur encode.
        const replayed = await audit.repositories.auditEntries.listForTenant(tenantA, {}, { cursor: cursorFromB, limit: 50 });
        const subjectIds = replayed.entries.map((entry) => entry.subjectUserId);
        expect(subjectIds).not.toContain(subjectBId);
        expect(subjectIds).not.toContain(subjectB2Id);
        expect(replayed.entries.every((entry) => entry.tenantId === tenantAId)).toBe(true);
      },
    );

    it(
      "un curseur issu d'une page du perimetre PLATEFORME (listForPlatform({kind:'ALL'})), rejoue sur listForTenant(A), " +
        "ne revele AUCUNE donnee d'un autre tenant et ne provoque JAMAIS une erreur 500 (ADR-0009 « Tests attendus »)",
      async () => {
        const tenantA = TenantId.create(tenantAId).getValue();

        // Page 1 du perimetre PLATEFORME (ALL, tous tenants + plateforme confondus), bornee a 1
        // ligne pour obtenir un `nextCursor` REEL — fenetre temporelle etroite pour la meme raison
        // que le bloc listForPlatform ci-dessus (base partagee entre fichiers de test).
        const firstPageOfAll = await audit.repositories.auditEntries.listForPlatform({ kind: 'ALL' }, narrowTimeWindow, {
          cursor: null,
          limit: 1,
        });
        expect(firstPageOfAll.nextCursor).not.toBeNull();
        const decoded = decodeAuditEntryCursor(firstPageOfAll.nextCursor as string);
        expect(decoded).not.toBeNull();
        const cursorFromPlatform = {
          occurredAt: new Date((decoded as NonNullable<typeof decoded>).occurredAt),
          id: (decoded as NonNullable<typeof decoded>).id,
        };

        // Rejoue SANS erreur (jamais un 500) : le filtre `tenantId = A` reste TOUJOURS reapplique
        // EN PLUS du curseur, quelle que soit la lecture d'origine (tenant OU plateforme) qui l'a
        // produit — "le curseur est une position, jamais une autorisation" (§6).
        const replayed = await audit.repositories.auditEntries.listForTenant(tenantA, {}, { cursor: cursorFromPlatform, limit: 50 });
        expect(replayed.entries.every((entry) => entry.tenantId === tenantAId)).toBe(true);
        expect(replayed.entries.map((entry) => entry.subjectUserId)).not.toContain(subjectBId);
        expect(replayed.entries.map((entry) => entry.subjectUserId)).not.toContain(platformSubjectId);
      },
    );
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
