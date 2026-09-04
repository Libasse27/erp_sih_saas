import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../identity/builders/testKit.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
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
      '(contrat du handler ; la preuve bout-en-bout que la couche de presentation ecrit bien ' +
      "AUDIT_TRAIL_QUERY_DENIED dans la chaine de l'ACTEUR sur ce meme refus, via le VRAI controleur HTTP, " +
      "SANS simulation, est apportee par auditHttpIsolation.test.ts (\"session A + ?tenantId=<B> (refus HTTP " +
      'reel...)")',
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
