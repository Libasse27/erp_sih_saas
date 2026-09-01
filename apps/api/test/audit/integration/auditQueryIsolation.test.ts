import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../identity/builders/testKit.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { buildAuditModule, type AuditModule } from '../../../src/modules/audit/infrastructure/AuditModule.js';
import type { AuditReadPrincipal } from '../../../src/modules/audit/application/AuditReadPrincipal.js';
import { createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Isolation inter-tenant — niveau QUERY HANDLERS (ADR-0009 §10, deuxieme des trois niveaux de
 * garde-fou exiges par le responsable technique ; le niveau REPOSITORY est couvert par
 * auditEntryTenantIsolation.test.ts, le niveau HTTP par auditHttpIsolation.test.ts).
 *
 * Exerce `ListAuditEntriesHandler`/`VerifyAuditChainIntegrityHandler`/`RecordAuditAccessHandler`
 * DIRECTEMENT (sans passer par le controleur HTTP), avec un `AuditReadPrincipal` construit a la
 * main — exactement comme le fait `composition-root.ts` en traduisant un `ServerContext` deja
 * resolu (ce fichier n'a donc besoin d'aucun module `identity`).
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('Audit — isolation inter-tenant, niveau QUERY HANDLERS (ADR-0009 §7/§9/§10)', () => {
  let prisma: PrismaClient;
  let audit: AuditModule;

  const tenantAId = uniqueId();
  const tenantBId = uniqueId();
  const actorAId = uniqueId();
  const platformActorId = uniqueId();

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    audit = buildAuditModule({ prisma, clock: new FixedClock('2026-08-29T09:00:00Z'), idGenerator: new UuidGenerator() });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function tenantPrincipal(overrides: Partial<Extract<AuditReadPrincipal, { kind: 'TENANT' }>> = {}): AuditReadPrincipal {
    return {
      kind: 'TENANT',
      actorUserId: actorAId,
      tenantId: tenantAId,
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['audit:read'],
      ...overrides,
    };
  }

  it(
    "un principal TENANT de A demandant EXPLICITEMENT le tenant B -> Result.failure('FORBIDDEN') " +
      "ET une entree AUDIT_TRAIL_QUERY_DENIED ecrite dans la chaine du tenant DE L'ACTEUR (A, jamais B)",
    async () => {
      const principal = tenantPrincipal();
      const requestedScope = { kind: 'TENANT' as const, tenantId: tenantBId };

      const result = await audit.queries.listAuditEntries.execute(principal, {
        filter: {},
        cursor: null,
        limit: 50,
        requestedScope,
      });
      expect(result.isFailure()).toBe(true);
      expect(result.getError()).toBe('FORBIDDEN');

      // Reproduit ce que fait la couche de presentation AVANT toute lecture (§7/§10) : la trace de
      // consultation refusee est ecrite AVANT que le refus soit renvoye au client.
      await audit.commands.recordAuditAccess.execute({
        principal,
        outcome: 'DENIED',
        sessionId: 'session-a',
        correlationId: null,
      });

      const tenantA = TenantId.create(tenantAId).getValue();
      const chainA = await audit.repositories.auditEntries.listForTenant(
        tenantA,
        { categories: ['AUDIT_ACCESS'], eventTypes: ['AUDIT_TRAIL_QUERY_DENIED'] },
        { cursor: null, limit: 50 },
      );
      expect(chainA.entries).toHaveLength(1);
      expect(chainA.entries[0]?.outcome).toBe('DENIED');
      expect(chainA.entries[0]?.actorUserId).toBe(actorAId);
      expect(chainA.entries[0]?.tenantId).toBe(tenantAId);

      // JAMAIS dans la chaine du tenant VISE (B) — l'incident n'a rien a voir avec B.
      const tenantB = TenantId.create(tenantBId).getValue();
      const chainB = await audit.repositories.auditEntries.listForTenant(
        tenantB,
        { categories: ['AUDIT_ACCESS'], eventTypes: ['AUDIT_TRAIL_QUERY_DENIED'] },
        { cursor: null, limit: 50 },
      );
      expect(chainB.entries).toHaveLength(0);
    },
  );

  it("un principal TENANT SANS audit:read (meme sur SON PROPRE tenant, aucun perimetre demande) -> Result.failure('FORBIDDEN')", async () => {
    const principal = tenantPrincipal({ permissionCodes: [] });

    const result = await audit.queries.listAuditEntries.execute(principal, {
      filter: {},
      cursor: null,
      limit: 50,
      requestedScope: null,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });

  it('un principal TENANT avec audit:read, AUCUN perimetre demande -> autorise, ne voit que SON tenant', async () => {
    const principal = tenantPrincipal();

    const result = await audit.queries.listAuditEntries.execute(principal, {
      filter: {},
      cursor: null,
      limit: 50,
      requestedScope: null,
    });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().entries.every((entry) => entry.tenantId === tenantAId)).toBe(true);
  });

  it("VerifyAuditChainIntegrity refuse la chaine d'un AUTRE tenant pour un principal TENANT", async () => {
    const principal = tenantPrincipal();

    const result = await audit.queries.verifyAuditChainIntegrity.execute(principal, {
      kind: 'TENANT',
      tenantId: tenantBId,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });

  it('VerifyAuditChainIntegrity refuse la chaine PLATEFORME pour un principal TENANT', async () => {
    const principal = tenantPrincipal();

    const result = await audit.queries.verifyAuditChainIntegrity.execute(principal, { kind: 'PLATFORM' });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });

  it('VerifyAuditChainIntegrity autorise un principal TENANT a verifier SA PROPRE chaine', async () => {
    const principal = tenantPrincipal();

    const result = await audit.queries.verifyAuditChainIntegrity.execute(principal, {
      kind: 'TENANT',
      tenantId: tenantAId,
    });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().chainKey).toBe(tenantAId);
  });

  it(
    'un principal PLATFORM PEUT lire N_IMPORTE QUEL tenant arbitraire via scope=tenant, SANS refus ' +
      '(decision complementaire validee par le responsable technique, ADR-0009 §7/§9 — jamais un test de platform-audit:read)',
    async () => {
      const platformPrincipal: AuditReadPrincipal = { kind: 'PLATFORM', actorUserId: platformActorId };

      const result = await audit.queries.listAuditEntries.execute(platformPrincipal, {
        filter: {},
        cursor: null,
        limit: 50,
        requestedScope: { kind: 'TENANT', tenantId: tenantBId },
      });

      expect(result.isSuccess()).toBe(true);
      expect(result.getValue().entries.every((entry) => entry.tenantId === tenantBId || entry.tenantId === null)).toBe(true);
    },
  );

  it('un principal PLATFORM PEUT verifier la chaine de N_IMPORTE QUEL tenant arbitraire, SANS refus', async () => {
    const platformPrincipal: AuditReadPrincipal = { kind: 'PLATFORM', actorUserId: platformActorId };

    const result = await audit.queries.verifyAuditChainIntegrity.execute(platformPrincipal, {
      kind: 'TENANT',
      tenantId: tenantBId,
    });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().chainKey).toBe(tenantBId);
  });
});
