import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { HealthFacility } from '../../../src/modules/tenant/domain/HealthFacility.js';
import { FacilityName } from '../../../src/modules/tenant/domain/value-objects/FacilityName.js';
import { PrismaHealthFacilityRepository } from '../../../src/modules/tenant/infrastructure/persistence/PrismaHealthFacilityRepository.js';
import { createRawPgClient, createTestPrismaClient, uniqueFacilityName } from './dbTestHelpers.js';

/**
 * Test le plus important de cette etape (Phase 0, etape 3/13, critere de reussite declare) :
 * verifie le Row-Level Security PostgreSQL sur `HealthFacility` en CONTOURNANT DELIBEREMENT la
 * couche applicative — connexion `pg` brute, aucun repository, aucun UnitOfWork. Se connecte
 * avec le role `sih_app` (non-superuser, non-BYPASSRLS — voir migration
 * `20260823173817_identity_rbac_app_role`) : un role superuser ignorerait systematiquement RLS,
 * ce qui rendrait ce test faussement vert.
 *
 * Couvre explicitement lecture ET ecriture (UPDATE/DELETE), pas seulement SELECT — le tenant A
 * ne doit jamais pouvoir lire NI modifier une ligne du tenant B, meme avec un identifiant valide.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('RLS — isolation inter-tenant sur HealthFacility (contournement applicatif)', () => {
  let client: Client;
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeAll(async () => {
    client = await createRawPgClient();
    await client.query('BEGIN');
    // Amorçage RLS (voir CreateHealthFacility.ts) : app.tenant_id doit deja correspondre a la
    // ligne qu'on insere, meme si elle n'existe encore nulle part — id et tenant_id de la ligne
    // sont la MEME valeur (tenantA), generee ici cote test comme le ferait l'application.
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `INSERT INTO "HealthFacility" (id, tenant_id, name, status, created_at)
       VALUES ($1, $1, 'Hopital Tenant A (test RLS)', 'ACTIVE', now())`,
      [tenantA],
    );
    await client.query('COMMIT');
  });

  afterAll(async () => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await client.query(`DELETE FROM "HealthFacility" WHERE id = $1`, [tenantA]);
    await client.query('COMMIT');
    await client.end();
  });

  it('le tenant B ne peut PAS lire la ligne du tenant A, meme avec un identifiant valide (SELECT)', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const result = await client.query('SELECT * FROM "HealthFacility" WHERE id = $1', [tenantA]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('le tenant B ne peut PAS modifier la ligne du tenant A (UPDATE) — 0 ligne affectee', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(`UPDATE "HealthFacility" SET name = 'Modifie par B' WHERE id = $1`, [tenantA]);
      expect(result.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('le tenant B ne peut PAS supprimer la ligne du tenant A (DELETE) — 0 ligne affectee', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const result = await client.query('DELETE FROM "HealthFacility" WHERE id = $1', [tenantA]);
      expect(result.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('le tenant A retrouve, modifie et lit bien sa propre ligne (le RLS ne bloque pas le proprietaire legitime)', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      const select = await client.query('SELECT * FROM "HealthFacility" WHERE id = $1', [tenantA]);
      expect(select.rows).toHaveLength(1);

      const update = await client.query(`UPDATE "HealthFacility" SET name = 'Renomme par A' WHERE id = $1`, [tenantA]);
      expect(update.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it("sans aucun app.tenant_id positionne, aucune ligne n_est visible (refus par defaut, contexte absent)", async () => {
    await client.query('BEGIN');
    try {
      const result = await client.query('SELECT * FROM "HealthFacility" WHERE id = $1', [tenantA]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it("l'INSERT est refuse si app.tenant_id ne correspond pas au tenant_id de la ligne inseree (amorçage RLS)", async () => {
    const mismatchedId = randomUUID();
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO "HealthFacility" (id, tenant_id, name, status, created_at)
           VALUES ($1, $2, 'Tentative incoherente', 'ACTIVE', now())`,
          [mismatchedId, tenantA],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it("l'inverse est vrai aussi : une ligne inseree pour un tenant C est invisible pour un tenant D", async () => {
    const tenantC = randomUUID();
    const tenantD = randomUUID();

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantC]);
    await client.query(
      `INSERT INTO "HealthFacility" (id, tenant_id, name, status, created_at)
       VALUES ($1, $1, 'Etablissement C (test RLS)', 'ACTIVE', now())`,
      [tenantC],
    );
    await client.query('COMMIT');

    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantD]);
      const result = await client.query('SELECT * FROM "HealthFacility" WHERE id = $1', [tenantC]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
    }

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantC]);
    await client.query('DELETE FROM "HealthFacility" WHERE id = $1', [tenantC]);
    await client.query('COMMIT');
  });
});

/**
 * Pendant applicatif du bloc RLS ci-dessus (etape 12/13, sweep d'isolation) : prouve la garde
 * EXPLICITE `if (!facility.id.equals(tenantId)) throw` de `PrismaHealthFacilityRepository.save()`
 * (~ligne 46) — une barriere DISTINCTE du RLS Postgres, qui intercepte AVANT toute requete une
 * tentative d'ecrire un agregat du tenant A sous un contexte tenant B. Passe par le VRAI
 * repository (pas de contournement SQL brut ici), a l'inverse du bloc ci-dessus.
 */
describe('HealthFacility — garde applicative de save() (contexte tenant errone)', () => {
  let prisma: PrismaClient;
  let client: Client;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    client = await createRawPgClient();
  });

  afterAll(async () => {
    await client.end();
    await prisma.$disconnect();
  });

  it(
    "save(facility, tenantB) leve une erreur AVANT toute requete et n'ecrit AUCUNE ligne : garde applicative " +
      "explicite (id === tenantId pour cet agregat, voir HealthFacility.ts)",
    async () => {
      const repository = new PrismaHealthFacilityRepository(prisma);
      const clock = new SystemClock();
      const idGenerator = new UuidGenerator();
      const facility = HealthFacility.create({
        name: FacilityName.create(uniqueFacilityName('Etablissement garde tenant')).getValue(),
        ownerUserId: randomUUID(),
        clock,
        idGenerator,
      });
      const rogueTenantId = TenantId.create(randomUUID()).getValue();

      await expect(repository.save(facility, rogueTenantId)).rejects.toThrow(
        "Tentative de sauvegarde d'un HealthFacility hors du tenant du contexte courant.",
      );

      // Verifie l'ABSENCE de ligne sous le VRAI tenant de l'agregat (`facility.id`, qui EST son
      // tenantId) : la garde a agi avant toute requete, aucune ecriture n'a donc pu avoir lieu,
      // ni sous le tenant fourni au contexte (rogueTenantId, refuse par le RLS de toute facon),
      // ni sous le tenant reel de l'agregat.
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [facility.id.toString()]);
        const rows = await client.query('SELECT id FROM "HealthFacility" WHERE id = $1', [facility.id.toString()]);
        expect(rows.rows).toHaveLength(0);
      } finally {
        await client.query('ROLLBACK');
      }
    },
  );
});
