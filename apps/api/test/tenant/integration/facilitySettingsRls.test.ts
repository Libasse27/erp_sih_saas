import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { FacilitySettings } from '../../../src/modules/tenant/domain/FacilitySettings.js';
import { PrismaFacilitySettingsRepository } from '../../../src/modules/tenant/infrastructure/persistence/PrismaFacilitySettingsRepository.js';
import { createRawPgClient, createTestPrismaClient } from './dbTestHelpers.js';

/**
 * Preuve COMPORTEMENTALE du Row-Level Security sur `FacilitySettings` (ADR-0008 §10/§11,
 * migration 20260828130000_tenant_facility_settings_provisioning) — ajoute a la revue de securite
 * de l'etape 10/13.
 *
 * Pourquoi ce fichier en plus de `rlsGuard.test.ts` : le garde-fou generique verifie seulement
 * la PRESENCE d'une politique et de `FORCE ROW LEVEL SECURITY` sur toute table du schema
 * `public` (metadonnees du catalogue), jamais son EFFET. `rls.test.ts` apporte cette preuve
 * comportementale pour `HealthFacility` uniquement. `FacilitySettings` est la PREMIERE table
 * tenant-scoped du depot dont `id` est DISTINCT de `tenant_id` : contrairement a
 * `HealthFacility` (ou l'identite de l'agregat EST le tenant, ce qui rend une ligne
 * inter-tenant structurellement impossible a designer), une ligne `FacilitySettings` peut etre
 * designee par un `id` qui ne dit RIEN de son tenant — la clause `WITH CHECK` implicite (Postgres
 * reutilise `USING` a l'INSERT quand `WITH CHECK` est omis) et le filtrage a la lecture sont donc
 * la seule chose qui empeche une ecriture ou une lecture croisee. Cela se prouve, cela ne se
 * suppose pas.
 *
 * Contourne DELIBEREMENT la couche applicative : connexion `pg` brute, aucun repository, aucun
 * UnitOfWork, role `sih_app` (non-superuser, non-BYPASSRLS — un superuser rendrait ce test
 * faussement vert).
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('RLS — isolation inter-tenant sur FacilitySettings (contournement applicatif)', () => {
  let client: Client;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const settingsA = randomUUID();

  async function insertSettingsForTenantA(): Promise<void> {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `INSERT INTO "FacilitySettings" (id, tenant_id, locale, timezone, currency, phone_country_code, created_at, provisioning_completed_at)
       VALUES ($1, $2, 'fr-SN', 'Africa/Dakar', 'XOF', '+221', now(), NULL)`,
      [settingsA, tenantA],
    );
    await client.query('COMMIT');
  }

  beforeAll(async () => {
    client = await createRawPgClient();
    await insertSettingsForTenantA();
  });

  afterAll(async () => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await client.query(`DELETE FROM "FacilitySettings" WHERE id = $1`, [settingsA]);
    await client.query('COMMIT');
    await client.end();
  });

  it('le tenant B ne peut PAS lire la configuration du tenant A, meme avec son identifiant exact (SELECT)', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const byId = await client.query('SELECT * FROM "FacilitySettings" WHERE id = $1', [settingsA]);
      expect(byId.rows).toHaveLength(0);
      const byTenant = await client.query('SELECT * FROM "FacilitySettings" WHERE tenant_id = $1', [tenantA]);
      expect(byTenant.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it("le tenant B ne peut PAS marquer le provisioning du tenant A comme termine (UPDATE) — 0 ligne affectee", async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(
        `UPDATE "FacilitySettings" SET provisioning_completed_at = now() WHERE id = $1`,
        [settingsA],
      );
      expect(result.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('le tenant B ne peut PAS supprimer la configuration du tenant A (DELETE) — 0 ligne affectee', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const result = await client.query('DELETE FROM "FacilitySettings" WHERE id = $1', [settingsA]);
      expect(result.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it("l'INSERT d'une configuration AU NOM d'un autre tenant est refuse (WITH CHECK implicite derive de USING)", async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      await expect(
        client.query(
          `INSERT INTO "FacilitySettings" (id, tenant_id, locale, timezone, currency, phone_country_code, created_at, provisioning_completed_at)
           VALUES ($1, $2, 'fr-SN', 'Africa/Dakar', 'XOF', '+221', now(), NULL)`,
          [randomUUID(), tenantA],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it("sans aucun app.tenant_id positionne, aucune ligne n_est visible (refus par defaut, contexte absent)", async () => {
    await client.query('BEGIN');
    try {
      const result = await client.query('SELECT * FROM "FacilitySettings" WHERE id = $1', [settingsA]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('le tenant A lit et modifie bien sa propre configuration (le RLS ne bloque pas le proprietaire legitime)', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      const select = await client.query('SELECT * FROM "FacilitySettings" WHERE id = $1', [settingsA]);
      expect(select.rows).toHaveLength(1);

      const update = await client.query(
        `UPDATE "FacilitySettings" SET provisioning_completed_at = now() WHERE id = $1`,
        [settingsA],
      );
      expect(update.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it("l'invariant \"au plus une configuration par tenant\" est impose par la base, pas seulement par l'applicatif (course entre deux seeds concurrents)", async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      await expect(
        client.query(
          `INSERT INTO "FacilitySettings" (id, tenant_id, locale, timezone, currency, phone_country_code, created_at, provisioning_completed_at)
           VALUES ($1, $2, 'fr-SN', 'Africa/Dakar', 'XOF', '+221', now(), NULL)`,
          [randomUUID(), tenantA],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

/**
 * Pendant applicatif du bloc RLS ci-dessus (etape 12/13, sweep d'isolation) : prouve la garde
 * EXPLICITE `if (!settings.tenantId.equals(tenantId)) throw` de
 * `PrismaFacilitySettingsRepository.save()` (~ligne 38) — une barriere DISTINCTE du RLS Postgres,
 * qui intercepte AVANT toute requete une tentative d'ecrire un agregat du tenant A sous un
 * contexte tenant B. Passe par le VRAI repository (pas de contournement SQL brut ici), a
 * l'inverse du bloc ci-dessus.
 */
describe('FacilitySettings — garde applicative de save() (contexte tenant errone)', () => {
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
    "save(settings, tenantB) leve une erreur AVANT toute requete et n'ecrit AUCUNE ligne : garde applicative " +
      'explicite, distincte du RLS (id != tenantId pour cet agregat, contrairement a HealthFacility)',
    async () => {
      const repository = new PrismaFacilitySettingsRepository(prisma);
      const clock = new SystemClock();
      const idGenerator = new UuidGenerator();
      const ownerTenantId = TenantId.create(randomUUID()).getValue();
      const settings = FacilitySettings.create({ tenantId: ownerTenantId, clock, idGenerator });
      const rogueTenantId = TenantId.create(randomUUID()).getValue();

      await expect(repository.save(settings, rogueTenantId)).rejects.toThrow(
        "Tentative de sauvegarde d'un FacilitySettings hors du tenant du contexte courant.",
      );

      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ownerTenantId.toString()]);
        const rows = await client.query('SELECT id FROM "FacilitySettings" WHERE id = $1', [settings.id.toString()]);
        expect(rows.rows).toHaveLength(0);
      } finally {
        await client.query('ROLLBACK');
      }
    },
  );
});
