import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { UserTenantMembership } from '../../../src/modules/identity/domain/UserTenantMembership.js';
import { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { PrismaUserTenantMembershipRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserTenantMembershipRepository.js';
import { createRawPgClient, createTestPrismaClient } from './dbTestHelpers.js';

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

  it('le tenant B ne peut PAS modifier la ligne du tenant A (UPDATE) — 0 ligne affectee', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(`UPDATE "UserTenantMembership" SET status = 'SUSPENDED' WHERE id = $1`, [
        membershipA,
      ]);
      expect(result.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('le tenant B ne peut PAS supprimer la ligne du tenant A (DELETE) — 0 ligne affectee', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const result = await client.query('DELETE FROM "UserTenantMembership" WHERE id = $1', [membershipA]);
      expect(result.rowCount).toBe(0);
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

/**
 * Pendant du premier bloc de ce fichier (UPDATE/DELETE croises), pour `MembershipRole` cette
 * fois — table de jonction membership <-> role, `tenant_id` DENORMALISE (voir schema Prisma) et
 * politique `tenant_isolation` de meme forme (migration 20260823174630, sans `FOR SELECT` :
 * s'applique donc a TOUTES les commandes, y compris UPDATE/DELETE). Necessite une ligne
 * `UserTenantMembership` et une ligne `Role` reelles pour satisfaire les FK — construites ici
 * dans une transaction dediee, distinctes de celles du premier bloc.
 */
describe('RLS — isolation inter-tenant sur MembershipRole (contournement applicatif)', () => {
  let client: Client;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const membershipA = randomUUID();
  const roleA = randomUUID();
  const membershipRoleA = randomUUID();

  beforeAll(async () => {
    client = await createRawPgClient();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `INSERT INTO "UserTenantMembership" (id, user_id, tenant_id, status, joined_at, created_at, created_by)
       VALUES ($1, $2, $3, 'ACTIVE', now(), now(), $2)`,
      [membershipA, userA, tenantA],
    );
    await client.query(
      `INSERT INTO "Role" (id, code, name, scope, tenant_id, permission_codes)
       VALUES ($1, 'ROLE_MEMBERSHIP_ROLE_RLS_TEST', 'Role test MembershipRole RLS', 'TENANT', $2, ARRAY['patient:read'])`,
      [roleA, tenantA],
    );
    await client.query(
      `INSERT INTO "MembershipRole" (id, membership_id, role_id, tenant_id, assigned_at)
       VALUES ($1, $2, $3, $4, now())`,
      [membershipRoleA, membershipA, roleA, tenantA],
    );
    await client.query('COMMIT');
  });

  afterAll(async () => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await client.query('DELETE FROM "MembershipRole" WHERE id = $1', [membershipRoleA]);
    await client.query('DELETE FROM "Role" WHERE id = $1', [roleA]);
    await client.query('DELETE FROM "UserTenantMembership" WHERE id = $1', [membershipA]);
    await client.query('COMMIT');
    await client.end();
  });

  it('le tenant B ne peut PAS lire la ligne du tenant A, meme avec un identifiant valide (SELECT)', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const result = await client.query('SELECT * FROM "MembershipRole" WHERE id = $1', [membershipRoleA]);
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('le tenant B ne peut PAS modifier la ligne du tenant A (UPDATE) — 0 ligne affectee', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const result = await client.query(`UPDATE "MembershipRole" SET assigned_at = now() WHERE id = $1`, [
        membershipRoleA,
      ]);
      expect(result.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('le tenant B ne peut PAS supprimer la ligne du tenant A (DELETE) — 0 ligne affectee', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const result = await client.query('DELETE FROM "MembershipRole" WHERE id = $1', [membershipRoleA]);
      expect(result.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('le tenant A lit et modifie bien sa propre ligne (le RLS ne bloque pas le proprietaire legitime)', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      const select = await client.query('SELECT * FROM "MembershipRole" WHERE id = $1', [membershipRoleA]);
      expect(select.rows).toHaveLength(1);

      const update = await client.query(`UPDATE "MembershipRole" SET assigned_at = now() WHERE id = $1`, [
        membershipRoleA,
      ]);
      expect(update.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

/**
 * Pendant applicatif des blocs RLS ci-dessus (etape 12/13, sweep d'isolation) : prouve la garde
 * EXPLICITE `if (!membership.tenantId.equals(tenantId)) throw` de
 * `PrismaUserTenantMembershipRepository.save()` (~ligne 90) — une barriere DISTINCTE du RLS
 * Postgres, qui intercepte AVANT toute requete une tentative d'ecrire un agregat du tenant A sous
 * un contexte tenant B. Passe par le VRAI repository (pas de contournement SQL brut ici).
 * `initialRoleIds` volontairement vide : evite toute dependance a une ligne `Role` reelle, la
 * garde intervient de toute facon avant que `save()` n'atteigne la synchronisation des roles.
 */
describe('UserTenantMembership — garde applicative de save() (contexte tenant errone)', () => {
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
    "save(membership, tenantB) leve une erreur AVANT toute requete et n'ecrit AUCUNE ligne : garde applicative " +
      'explicite, distincte du RLS',
    async () => {
      const repository = new PrismaUserTenantMembershipRepository(prisma, new SystemClock(), new UuidGenerator());
      const clock = new SystemClock();
      const idGenerator = new UuidGenerator();
      const ownerTenantId = TenantId.create(randomUUID()).getValue();
      const membership = UserTenantMembership.grant({
        userId: UserAccountId.create(randomUUID()).getValue(),
        tenantId: ownerTenantId,
        createdBy: UserAccountId.create(randomUUID()).getValue(),
        initialRoleIds: [],
        clock,
        idGenerator,
      });
      const rogueTenantId = TenantId.create(randomUUID()).getValue();

      await expect(repository.save(membership, rogueTenantId)).rejects.toThrow(
        "Tentative de sauvegarde d'un UserTenantMembership hors du tenant du contexte courant.",
      );

      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ownerTenantId.toString()]);
        const rows = await client.query('SELECT id FROM "UserTenantMembership" WHERE id = $1', [
          membership.id.toString(),
        ]);
        expect(rows.rows).toHaveLength(0);
      } finally {
        await client.query('ROLLBACK');
      }
    },
  );
});
