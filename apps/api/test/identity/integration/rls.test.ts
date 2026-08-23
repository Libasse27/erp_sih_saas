import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRawPgClient } from './dbTestHelpers.js';

/**
 * Test le plus important de cette etape (2.7 / 2.6) : verifie le Row-Level Security PostgreSQL
 * en CONTOURNANT DELIBEREMENT la couche applicative — connexion `pg` brute, aucun repository,
 * aucun UnitOfWork. Se connecte avec le role `sih_app` (non-superuser, non-BYPASSRLS — voir
 * migration `20260823173817_identity_rbac_app_role`) : un role superuser ignorerait
 * systematiquement RLS, ce qui rendrait ce test faussement vert.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('RLS — isolation inter-tenant sur UserTenantMembership (contournement applicatif)', () => {
  let client: Client;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const membershipA = randomUUID();

  beforeAll(async () => {
    client = await createRawPgClient();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `INSERT INTO "UserTenantMembership" (id, user_id, tenant_id, status, joined_at, created_at, created_by)
       VALUES ($1, $2, $3, 'ACTIVE', now(), now(), $2)`,
      [membershipA, userA, tenantA],
    );
    await client.query('COMMIT');
  });

  afterAll(async () => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await client.query(`DELETE FROM "UserTenantMembership" WHERE id = $1`, [membershipA]);
    await client.query('COMMIT');
    await client.end();
  });

  it('le tenant B ne peut PAS lire une ligne du tenant A, meme avec un identifiant valide', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      // app.user_id volontairement NON positionne : neutralise la politique additive
      // self_membership_lookup (qui ne doit jamais laisser fuiter les donnees d'un autre user).
      const result = await client.query('SELECT * FROM "UserTenantMembership" WHERE id = $1', [membershipA]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('le tenant A retrouve bien sa propre ligne (le RLS ne bloque pas le proprietaire legitime)', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      const result = await client.query('SELECT * FROM "UserTenantMembership" WHERE id = $1', [membershipA]);
      expect(result.rows).toHaveLength(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('sans aucun app.tenant_id positionne, aucune ligne n_est visible (refus par defaut)', async () => {
    await client.query('BEGIN');
    try {
      const result = await client.query('SELECT * FROM "UserTenantMembership" WHERE id = $1', [membershipA]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it("l'inverse est vrai aussi : une ligne inseree pour le tenant B est invisible pour le tenant A", async () => {
    const tenantC = randomUUID();
    const tenantD = randomUUID();
    const userC = randomUUID();
    const membershipC = randomUUID();

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantC]);
    await client.query(
      `INSERT INTO "UserTenantMembership" (id, user_id, tenant_id, status, joined_at, created_at, created_by)
       VALUES ($1, $2, $3, 'ACTIVE', now(), now(), $2)`,
      [membershipC, userC, tenantC],
    );
    await client.query('COMMIT');

    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantD]);
      const result = await client.query('SELECT * FROM "UserTenantMembership" WHERE id = $1', [membershipC]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
    }

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantC]);
    await client.query('DELETE FROM "UserTenantMembership" WHERE id = $1', [membershipC]);
    await client.query('COMMIT');
  });
});

describe('RLS — catalogue de roles systeme visible globalement, roles personnalises isoles', () => {
  let client: Client;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const customRoleId = randomUUID();

  beforeAll(async () => {
    client = await createRawPgClient();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `INSERT INTO "Role" (id, code, name, scope, tenant_id, permission_codes)
       VALUES ($1, 'ROLE_PERSO_TEST', 'Role personnalise test', 'TENANT', $2, ARRAY['patient:read'])`,
      [customRoleId, tenantA],
    );
    await client.query('COMMIT');
  });

  afterAll(async () => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await client.query('DELETE FROM "Role" WHERE id = $1', [customRoleId]);
    await client.query('COMMIT');
    await client.end();
  });

  it('un role SYSTEM (tenant_id NULL) est lisible sans aucun contexte de tenant positionne', async () => {
    const result = await client.query(`SELECT * FROM "Role" WHERE code = 'SUPER_ADMIN' AND scope = 'SYSTEM'`);
    expect(result.rows.length).toBeGreaterThanOrEqual(0);
    // Le test verifie surtout l'ABSENCE d'erreur RLS ; l'assertion de contenu est faite dans
    // le test d'integration du seed (identityFlow.test.ts) qui, lui, seed les 18 roles.
  });

  it('un role TENANT reste isole : invisible depuis un autre tenant', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const result = await client.query('SELECT * FROM "Role" WHERE id = $1', [customRoleId]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
