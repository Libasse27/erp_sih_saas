import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { PrismaHealthFacilityRepository } from '../../../src/modules/tenant/infrastructure/persistence/PrismaHealthFacilityRepository.js';
import { RenameHealthFacilityHandler } from '../../../src/modules/tenant/application/commands/RenameHealthFacility.js';
import type { TenantConfigPrincipal } from '../../../src/modules/tenant/application/TenantConfigPrincipal.js';
import { InMemoryTenantConfigAuditTrail } from '../builders/testKit.js';
import { createRawPgClient, createTestPrismaClient, uniqueFacilityName } from './dbTestHelpers.js';

const ACTOR_A = randomUUID();
const ACTOR_B = randomUUID();

function tenantPrincipal(tenantId: string, actorUserId: string): TenantConfigPrincipal {
  return {
    kind: 'TENANT',
    actorUserId,
    tenantId,
    roleCodes: ['ADMIN_ETABLISSEMENT'],
    permissionCodes: ['tenant-config:administer'],
  };
}

/**
 * Preuve d'isolation inter-tenant REELLE (PostgreSQL RLS FORCE, pas seulement l'application) pour
 * `RenameHealthFacilityHandler` — Phase 1, premier increment vertical. Complementaire de
 * `rls.test.ts` (qui prouve la meme isolation au niveau SQL brut / repository seul, generiquement
 * pour `HealthFacility`) : ce fichier exerce la TRANCHE VERTICALE complete (handler ->
 * `PrismaHealthFacilityRepository` -> RLS) specifiquement pour le renommage.
 *
 * Design NOTABLE : `RenameHealthFacilityCommand` n'expose STRUCTURELLEMENT aucun champ `tenantId`
 * — le tenant cible est TOUJOURS derive de `principal` (lui-meme issu du `ServerContext` serveur,
 * jamais du client). Il n'existe donc aucune valeur de `tenantId` a "forger" au niveau de la
 * commande elle-meme : la preuve porte ici sur le fait qu'une session tenant A, quoi qu'il arrive,
 * ne peut JAMAIS lire ni modifier la ligne du tenant B — meme en connaissant son identifiant exact
 * (utilise ci-dessous pour une lecture directe via le repository sous contexte A). La preuve HTTP
 * complementaire (tenantId forge dans le corps JSON, ignore) est dans facilityHttp.test.ts.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('RenameHealthFacilityHandler — isolation inter-tenant reelle (RLS FORCE)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let repository: PrismaHealthFacilityRepository;
  let unitOfWork: PgUnitOfWork;
  let tenantA: TenantId;
  let tenantB: TenantId;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    repository = new PrismaHealthFacilityRepository(prisma);
    unitOfWork = new PgUnitOfWork(prisma);

    tenantA = TenantId.create(randomUUID()).getValue();
    tenantB = TenantId.create(randomUUID()).getValue();

    // Amorçage RLS (meme discipline que rls.test.ts/CreateHealthFacility.ts) : chaque ligne est
    // inseree sous SON PROPRE contexte tenant, id === tenant_id pour cet agregat.
    await rawClient.query('BEGIN');
    await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.toString()]);
    await rawClient.query(
      `INSERT INTO "HealthFacility" (id, tenant_id, name, status, created_at)
       VALUES ($1, $1, $2, 'ACTIVE', now())`,
      [tenantA.toString(), uniqueFacilityName('Etablissement A (rename RLS)')],
    );
    await rawClient.query('COMMIT');

    await rawClient.query('BEGIN');
    await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB.toString()]);
    await rawClient.query(
      `INSERT INTO "HealthFacility" (id, tenant_id, name, status, created_at)
       VALUES ($1, $1, $2, 'ACTIVE', now())`,
      [tenantB.toString(), uniqueFacilityName('Etablissement B (rename RLS)')],
    );
    await rawClient.query('COMMIT');
  });

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await rawClient.query('BEGIN');
      await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId.toString()]);
      await rawClient.query('DELETE FROM "HealthFacility" WHERE id = $1', [tenantId.toString()]);
      await rawClient.query('COMMIT');
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  /** Lecture de verification SOUS RLS FORCE (meme discipline que rls.test.ts) : `app.tenant_id` doit etre positionne DANS LA MEME transaction que le SELECT, jamais une lecture "nue". */
  async function readFacilityName(tenantId: TenantId): Promise<string | undefined> {
    await rawClient.query('BEGIN');
    try {
      await rawClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId.toString()]);
      const result = await rawClient.query<{ name: string }>('SELECT name FROM "HealthFacility" WHERE id = $1', [
        tenantId.toString(),
      ]);
      return result.rows[0]?.name;
    } finally {
      await rawClient.query('COMMIT');
    }
  }

  function realHandler(): RenameHealthFacilityHandler {
    return new RenameHealthFacilityHandler(
      repository,
      unitOfWork,
      new SystemClock(),
      new UuidGenerator(),
      new InMemoryTenantConfigAuditTrail(),
    );
  }

  it(
    "une session TENANT A renomme SA PROPRE ligne avec succes, MEME SI elle connait l'identifiant exact du tenant B : " +
      'la ligne du tenant B reste PROVABLEMENT intacte (verifie par une lecture SOUS LE CONTEXTE RLS de B)',
    async () => {
      const handler = realHandler();

      const resultA = await handler.execute({
        principal: tenantPrincipal(tenantA.toString(), ACTOR_A),
        newName: 'Etablissement A Renomme (RLS reel)',
        sessionId: null,
        correlationId: null,
      });
      expect(resultA.isSuccess()).toBe(true);
      expect(resultA.getValue().name).toBe('Etablissement A Renomme (RLS reel)');

      // Lecture DIRECTE du repository sous le contexte RLS du tenant A, ciblant l'identifiant EXACT
      // du tenant B (connu ici cote test) : RLS bloque, jamais l'application — 0 ligne visible,
      // jamais la ligne de B elle-meme.
      const crossTenantRead = await unitOfWork.withTransaction(() => repository.findByTenantId(tenantB), {
        tenantId: tenantA,
      });
      expect(crossTenantRead).toBeNull();

      // La ligne de B, relue SOUS SON PROPRE contexte, est bien restee intacte (nom d'origine).
      const bName = await readFacilityName(tenantB);
      expect(bName).not.toBe('Etablissement A Renomme (RLS reel)');
      expect(bName).toContain('Etablissement B (rename RLS)');
    },
  );

  it('une session TENANT B renomme sa propre ligne independamment — aucune interference avec le renommage precedent de A', async () => {
    const handler = realHandler();

    const resultB = await handler.execute({
      principal: tenantPrincipal(tenantB.toString(), ACTOR_B),
      newName: 'Etablissement B Renomme (RLS reel)',
      sessionId: null,
      correlationId: null,
    });

    expect(resultB.isSuccess()).toBe(true);
    expect(resultB.getValue().name).toBe('Etablissement B Renomme (RLS reel)');

    expect(await readFacilityName(tenantA)).toBe('Etablissement A Renomme (RLS reel)');
  });
});
