-- =================================================================================================
-- Phase 0, etape 11/13 ("Audit plateforme") — ADR-0009. Extension STRICTEMENT ADDITIVE de
-- `platform.AuditEntry` : AUCUN `UPDATE` sur une ligne existante, le trigger append-only
-- (`audit_entry_append_only`, migrations 20260826150000/20260826160000) N'EST JAMAIS desactive,
-- meme temporairement.
--
-- Contenu, dans l'ordre :
--   1. Nouvelles valeurs `AuditCategory`/`AuditEventType` (ALTER TYPE ... ADD VALUE, jamais
--      utilisees dans CETTE MEME transaction de migration — restriction PostgreSQL, meme
--      discipline que 20260828090000_refresh_token_rotation).
--   2. Nouveaux types `ActorKind`/`AuditTargetType` (CREATE TYPE complet — pas de restriction
--      "meme transaction" ici, seule `ALTER TYPE ... ADD VALUE` y est soumise).
--   3. Colonnes `actor_kind`/`target_type`/`target_id` + `actor_user_id`/`subject_user_id`
--      NULLABLES + contraintes CHECK (ADR-0009 §3).
--   4. Colonnes de chainage SHA-256 : `chain_key` (GENEREE STORED), `chain_sequence`,
--      `previous_entry_hash`, `entry_hash` + trigger BEFORE INSERT + index uniques anti-fourche
--      (ADR-0009 §5).
--   5. Index de pagination/lecture (ADR-0009 §6).
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- 1. Nouvelles valeurs d'enumeration (ADR-0009 §2)
-- -------------------------------------------------------------------------------------------------

ALTER TYPE "platform"."AuditCategory" ADD VALUE 'PROVISIONING';
ALTER TYPE "platform"."AuditCategory" ADD VALUE 'MEMBERSHIP';
ALTER TYPE "platform"."AuditCategory" ADD VALUE 'SUBSCRIPTION';
ALTER TYPE "platform"."AuditCategory" ADD VALUE 'BILLING';
ALTER TYPE "platform"."AuditCategory" ADD VALUE 'AUDIT_ACCESS';

ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SESSION_LOGIN_SUCCEEDED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SESSION_LOGIN_FAILED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SESSION_CONTEXT_OPENED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SESSION_CONTEXT_DENIED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SESSION_CLOSED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'PROVISIONING_FACILITY_CREATED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'PROVISIONING_CONFIGURATION_SEEDED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'PROVISIONING_COMPLETED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'MEMBERSHIP_GRANTED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'MEMBERSHIP_REVOKED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'MEMBERSHIP_ROLE_ASSIGNED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'MEMBERSHIP_ROLE_UNASSIGNED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SUBSCRIPTION_TRIAL_STARTED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SUBSCRIPTION_PLAN_UPGRADE_REQUESTED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SUBSCRIPTION_PLAN_CHANGED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SUBSCRIPTION_RENEWED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SUBSCRIPTION_GRACE_PERIOD_STARTED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SUBSCRIPTION_DEGRADED_MODE_ENTERED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SUBSCRIPTION_DEGRADED_MODE_SUSTAINED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SUBSCRIPTION_REACTIVATED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'BILLING_PAYMENT_INITIATED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'BILLING_PAYMENT_CONFIRMED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'BILLING_PLATFORM_INVOICE_ISSUED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'BILLING_PLATFORM_INVOICE_SETTLED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'AUDIT_TRAIL_QUERIED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'AUDIT_TRAIL_QUERY_DENIED';

-- -------------------------------------------------------------------------------------------------
-- 2. Nouveaux types (ADR-0009 §3) — CREATE TYPE complet, aucune restriction "meme transaction".
-- -------------------------------------------------------------------------------------------------

CREATE TYPE "platform"."ActorKind" AS ENUM ('USER_TENANT', 'USER_PLATFORM', 'SYSTEM');

CREATE TYPE "platform"."AuditTargetType" AS ENUM (
  'USER_ACCOUNT', 'MEMBERSHIP', 'HEALTH_FACILITY', 'SUBSCRIPTION', 'PAYMENT',
  'PLATFORM_INVOICE', 'FACILITY_SETTINGS', 'AUDIT_TRAIL'
);

-- -------------------------------------------------------------------------------------------------
-- 3. Colonnes acteur/cible (ADR-0009 §3) — ADD COLUMN ... DEFAULT (metadonnees, aucune reecriture),
--    valeurs par defaut = valeurs EXACTES des entrees MFA/SESSION deja ecrites.
-- -------------------------------------------------------------------------------------------------

ALTER TABLE "platform"."AuditEntry"
  ADD COLUMN "actor_kind" "platform"."ActorKind" NOT NULL DEFAULT 'USER_TENANT',
  ADD COLUMN "target_type" "platform"."AuditTargetType" NOT NULL DEFAULT 'USER_ACCOUNT',
  ADD COLUMN "target_id" TEXT;

-- `actor_user_id`/`subject_user_id` deviennent NULLABLES (ADR-0009 §3 — SYSTEM n'a pas d'acteur
-- humain ; une consultation du journal n'a pas de sujet utilisateur). Simple metadonnee
-- (DROP NOT NULL), aucune reecriture de ligne.
ALTER TABLE "platform"."AuditEntry" ALTER COLUMN "actor_user_id" DROP NOT NULL;
ALTER TABLE "platform"."AuditEntry" ALTER COLUMN "subject_user_id" DROP NOT NULL;

-- Invariants verifies par le moteur (ADR-0009 §3, alternative ecartee #7 : jamais un identifiant
-- sentinelle). Toutes les lignes existantes satisfont trivialement les deux (actor_kind par
-- defaut USER_TENANT + actor_user_id deja NOT NULL avant cette migration ; target_type par
-- defaut USER_ACCOUNT + subject_user_id deja NOT NULL avant cette migration).
ALTER TABLE "platform"."AuditEntry"
  ADD CONSTRAINT "AuditEntry_actor_kind_actor_user_id_check"
  CHECK (
    (actor_kind = 'SYSTEM' AND actor_user_id IS NULL)
    OR (actor_kind <> 'SYSTEM' AND actor_user_id IS NOT NULL)
  );

ALTER TABLE "platform"."AuditEntry"
  ADD CONSTRAINT "AuditEntry_target_type_subject_user_id_check"
  CHECK (
    (target_type = 'USER_ACCOUNT' AND subject_user_id IS NOT NULL)
    OR target_type <> 'USER_ACCOUNT'
  );

-- -------------------------------------------------------------------------------------------------
-- 4. Chainage SHA-256 par perimetre (ADR-0009 §5).
-- -------------------------------------------------------------------------------------------------

-- Colonne GENEREE STORED : derivee, JAMAIS ecrite par l'application (Prisma l'omet de tout INSERT,
-- voir schema.prisma `@default(dbgenerated(...))`). Contrairement aux ADD COLUMN ci-dessus, cette
-- operation MATERIALISE la valeur pour chaque ligne existante (necessaire pour une colonne
-- GENERATED ... STORED) — cout ponctuel accepte, aucune ligne n'est semantiquement modifiee
-- (la valeur est entierement derivee de `tenant_id`, deja present).
ALTER TABLE "platform"."AuditEntry"
  ADD COLUMN "chain_key" TEXT GENERATED ALWAYS AS (COALESCE("tenant_id"::text, 'PLATFORM')) STORED;

-- Position et empreintes de chaine — NULLABLES, AUCUN DEFAULT : toute ligne ecrite AVANT cette
-- migration reste a NULL pour les trois colonnes (segment "pre-chaine", ADR-0009 §5.3 — jamais
-- retro-chaine, cela exigerait un UPDATE donc la suspension du trigger append-only).
ALTER TABLE "platform"."AuditEntry"
  ADD COLUMN "chain_sequence" BIGINT,
  ADD COLUMN "previous_entry_hash" TEXT,
  ADD COLUMN "entry_hash" TEXT;

-- Deuxieme defense (deux defenses independantes, doctrine deja appliquee a l'append-only) :
-- AUCUNE nouvelle ligne ne peut echapper a la chaine, le contrat applicatif seul ne suffit pas.
-- Reutilise la MEME discipline que `audit_entry_is_append_only()` (fonction dediee, nom distinct
-- car le message d'erreur et la condition different).
CREATE OR REPLACE FUNCTION platform.audit_entry_requires_hash() RETURNS trigger AS $$
BEGIN
  IF NEW.entry_hash IS NULL THEN
    RAISE EXCEPTION 'platform.AuditEntry : entry_hash obligatoire a l''insertion (chainage SHA-256, ADR-0009 §5.3).';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_entry_requires_hash
  BEFORE INSERT ON "platform"."AuditEntry"
  FOR EACH ROW EXECUTE FUNCTION platform.audit_entry_requires_hash();

-- Concurrence — DEUX defenses independantes (ADR-0009 §5.3), en plus du verrou consultatif
-- `pg_advisory_xact_lock(hashtext(chain_key))` pris cote application AVANT la lecture de la queue
-- de chaine (PrismaAuditEntryRepository.append()) : ces index UNIQUES rendent la fourche
-- IMPOSSIBLE meme si le verrou etait oublie.
CREATE UNIQUE INDEX "AuditEntry_chain_key_previous_entry_hash_key"
  ON "platform"."AuditEntry" ("chain_key", "previous_entry_hash")
  WHERE "previous_entry_hash" IS NOT NULL;

CREATE UNIQUE INDEX "AuditEntry_chain_key_genesis_key"
  ON "platform"."AuditEntry" ("chain_key")
  WHERE "entry_hash" IS NOT NULL AND "previous_entry_hash" IS NULL;

-- -------------------------------------------------------------------------------------------------
-- 5. Index de lecture (ADR-0009 §6) — pagination keyset (tenant_id, occurred_at DESC, id DESC) et
--    lecture de la queue de chaine (chain_key, chain_sequence DESC), prefixe TOUJOURS tenant_id
--    (ESR : Equality -> Sort -> Range).
-- -------------------------------------------------------------------------------------------------

CREATE INDEX "AuditEntry_tenant_id_occurred_at_id_idx"
  ON "platform"."AuditEntry" ("tenant_id", "occurred_at" DESC, "id" DESC);

CREATE INDEX "AuditEntry_chain_key_chain_sequence_idx"
  ON "platform"."AuditEntry" ("chain_key", "chain_sequence" DESC);

-- Pas de ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY : `platform.AuditEntry` reste HORS RLS
-- par construction (ADR-0005 §5, ADR-0009 §Contexte 7) — voir
-- test/tenant/integration/rlsGuard.test.ts (PLATFORM_TABLES_WITHOUT_RLS), INCHANGE par cette
-- etape (aucune nouvelle TABLE plateforme, seulement des colonnes sur AuditEntry).
