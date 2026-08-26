import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRawPgClient } from './dbTestHelpers.js';

/**
 * Garde-fou generique impose par ADR-0001 (section "Consequences", mitigation NON NEGOCIABLE
 * pour Phase 0) : "un test automatise en CI qui enumere les tables du schema tenant et echoue
 * si l'une n'a pas `tenant_id NOT NULL` ET une politique RLS active". Ce test est le livrable
 * de cette exigence — il ne teste pas UNE table en particulier (voir rls.test.ts pour
 * HealthFacility, test/identity/integration/rls.test.ts pour UserTenantMembership/Role), il
 * enumere TOUT le schema `public` et echoue des qu'une table tenant-scoped est ajoutee sans
 * `tenant_id NOT NULL` et sans politique RLS active — regression detectee automatiquement,
 * sans qu'un developpeur ait a se souvenir de mettre a jour une liste manuelle.
 *
 * Connecte avec le role `sih_app` (non-superuser, non-BYPASSRLS) : le role le moins privilegie
 * suffisant pour lire le catalogue systeme (`pg_tables`, `pg_policies`, `information_schema`) —
 * jamais le role `sih` (superuser), qui rendrait un test RLS faussement vert. Lire le catalogue
 * ne necessite aucun privilege special au-dela de l'acces au schema, deja accorde a `sih_app`.
 *
 * `Role` est un cas particulier documente et volontairement exclu de l'exigence
 * `tenant_id NOT NULL` : c'est une table MIXTE (lignes SYSTEM globales, tenant_id NULL, + lignes
 * TENANT isolees) — voir le commentaire sur ce modele dans prisma/schema.prisma. Elle reste
 * couverte par l'exigence de politique RLS active (qui, elle, s'applique sans exception).
 */
describe('ADR-0001 — garde-fou generique : toute table du schema public a tenant_id NOT NULL + RLS actif', () => {
  let client: Client;

  // `Role` est la seule exception documentee a `tenant_id NOT NULL` (table mixte SYSTEM/TENANT,
  // voir commentaire de tete de suite). Toute AUTRE table future doit satisfaire les deux
  // exigences sans exception ajoutee ici a la legere.
  const TABLES_EXEMPTED_FROM_NOT_NULL = new Set(['Role']);

  beforeAll(async () => {
    client = await createRawPgClient();
  });

  afterAll(async () => {
    await client.end();
  });

  async function listPublicTenantScopedTables(): Promise<string[]> {
    // Une table "tenant-scoped" au sens de ce garde-fou est une table de base (BASE TABLE, pas
    // une vue) du schema public, hors tables techniques Prisma (`_prisma_migrations`).
    const result = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'`,
    );
    return result.rows.map((row) => row.tablename);
  }

  async function hasNotNullTenantId(tableName: string): Promise<boolean> {
    const result = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'`,
      [tableName],
    );
    return result.rows.length > 0 && result.rows[0]?.is_nullable === 'NO';
  }

  async function hasActiveRlsPolicy(tableName: string): Promise<boolean> {
    const forced = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
      [tableName],
    );
    if (forced.rows.length === 0 || !forced.rows[0]?.relrowsecurity || !forced.rows[0]?.relforcerowsecurity) {
      return false;
    }
    const policies = await client.query(`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`, [
      tableName,
    ]);
    return policies.rows.length > 0;
  }

  it('enumere au moins les tables tenant-scoped connues de cette etape (couverture minimale du garde-fou)', async () => {
    const tables = await listPublicTenantScopedTables();
    expect(tables).toEqual(
      expect.arrayContaining(['UserTenantMembership', 'MembershipRole', 'Role', 'HealthFacility']),
    );
  });

  it('chaque table du schema public a soit tenant_id NOT NULL, soit une exemption documentee, ET une politique RLS active', async () => {
    const tables = await listPublicTenantScopedTables();
    expect(tables.length).toBeGreaterThan(0);

    const failures: string[] = [];

    for (const table of tables) {
      const notNull = await hasNotNullTenantId(table);
      const rlsActive = await hasActiveRlsPolicy(table);

      if (!rlsActive) {
        failures.push(`${table} : aucune politique RLS active (FORCE ROW LEVEL SECURITY + CREATE POLICY attendus)`);
      }
      if (!notNull && !TABLES_EXEMPTED_FROM_NOT_NULL.has(table)) {
        failures.push(`${table} : colonne tenant_id absente ou nullable, et non exemptee explicitement`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('HealthFacility en particulier satisfait les deux exigences (agregat racine du tenant, aucune exception)', async () => {
    expect(await hasNotNullTenantId('HealthFacility')).toBe(true);
    expect(await hasActiveRlsPolicy('HealthFacility')).toBe(true);
  });
});

/**
 * Garde-fou MIROIR du precedent (revue de securite, etape 6/13) : la ou le garde-fou ci-dessus
 * impose RLS a toute table de `public`, celui-ci impose qu'AUCUNE table de `platform` ne porte
 * de RLS, ET que la liste des tables de ce schema soit une LISTE BLANCHE explicite — toute
 * nouvelle table `platform` doit etre une decision CONSCIENTE (ajoutee ici avec une justification,
 * voir schema.prisma) plutot qu'un defaut silencieux qui echapperait a la fois a ce garde-fou et
 * a celui de `public` (une table qui n'est dans AUCUNE des deux listes ne serait testee nulle
 * part).
 */
describe('ADR-0001 §3.3 — garde-fou generique : toute table du schema platform hors RLS est une liste blanche consciente', () => {
  let client: Client;

  // Chaque entree correspond a une decision documentee dans schema.prisma (section "Module
  // Payment"/"Module Subscription"/Outbox) : donnees de niveau PLATEFORME, filtrage tenant
  // PUREMENT APPLICATIF (voir les repositories Prisma correspondants), jamais par RLS.
  const PLATFORM_TABLES_WITHOUT_RLS = new Set([
    'UserAccount',
    'Permission',
    'Plan',
    'PlanPrice',
    'Subscription',
    'SubscriptionPlanChange',
    'SubscriptionPlanUpgradeRequest',
    'OutboxMessage',
    'OutboxConsumedEvent',
    'Payment',
    'PlatformInvoice',
    // Etape 7/13 (ADR-0005 §1) : MFA lie a UserAccount par identifiant uniquement — concept
    // d'identite GLOBALE, jamais tenant-scoped (un SUPER_ADMIN, sans tenant, y est soumis au
    // meme titre qu'un utilisateur d'etablissement).
    'MfaEnrollment',
    'MfaRecoveryCode',
    // Etape 7/13 (ADR-0005 §5) : un evenement MFA en contexte PLATFORM n'a pas de tenant ; une
    // politique RLS refuserait purement et simplement l'insertion d'une ligne sans
    // app.tenant_id positionne, rendant le journal muet sur le role le plus sensible de la
    // plateforme. Filtrage tenant PUREMENT APPLICATIF (voir auditEntryTenantIsolation.test.ts).
    'AuditEntry',
  ]);

  beforeAll(async () => {
    client = await createRawPgClient();
  });

  afterAll(async () => {
    await client.end();
  });

  async function listPlatformTables(): Promise<string[]> {
    const result = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'platform' AND tablename NOT LIKE '\\_prisma%'`,
    );
    return result.rows.map((row) => row.tablename);
  }

  it("la liste des tables du schema platform correspond EXACTEMENT a la liste blanche documentee (toute nouvelle table est une decision consciente, jamais un defaut silencieux)", async () => {
    const actual = new Set(await listPlatformTables());

    const undocumented = [...actual].filter((table) => !PLATFORM_TABLES_WITHOUT_RLS.has(table));
    expect(undocumented).toEqual([]);

    const missing = [...PLATFORM_TABLES_WITHOUT_RLS].filter((table) => !actual.has(table));
    expect(missing).toEqual([]);
  });

  it('aucune table du schema platform ne porte de politique RLS active (ADR-0001 §3.3 : hors RLS par construction)', async () => {
    for (const table of PLATFORM_TABLES_WITHOUT_RLS) {
      const result = await client.query<{ relforcerowsecurity: boolean }>(
        `SELECT relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'platform'::regnamespace`,
        [table],
      );
      expect(result.rows[0]?.relforcerowsecurity ?? false).toBe(false);
    }
  });
});
