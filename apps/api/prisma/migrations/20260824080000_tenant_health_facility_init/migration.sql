-- CreateEnum
CREATE TYPE "FacilityStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "HealthFacility" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "FacilityStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthFacility_pkey" PRIMARY KEY ("id")
);

-- =============================================================================================
-- Row-Level Security (ADR-0001, couche 4 de la defense en profondeur — "garantie de dernier
-- recours", jamais la seule barriere : PrismaHealthFacilityRepository filtre aussi
-- explicitement par tenant_id, voir apps/api/src/modules/tenant/infrastructure/persistence/).
--
-- `tenant_id` duplique `id` sur cette table par construction (voir schema.prisma) : cette table
-- EST le tenant, contrairement aux autres tables tenant-scoped du schema ou `tenant_id`
-- reference un tenant distinct de la ligne. La politique ci-dessous reste identique dans sa
-- forme a celle des autres tables (`tenant_id = ...`) : c'est precisement ce qui permet au
-- garde-fou generique (test/tenant/integration/rlsGuard.test.ts) de traiter HealthFacility sans
-- aucun cas particulier.
-- =============================================================================================

ALTER TABLE "HealthFacility" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HealthFacility" FORCE ROW LEVEL SECURITY;

-- Forme standard NULLIF (voir migration 20260823174630_identity_rbac_rls_nullif_fix pour
-- l'explication complete : `current_setting(..., true)` peut renvoyer '' plutot que NULL sur
-- une connexion poolee ayant deja positionne ce parametre custom au moins une fois).
CREATE POLICY tenant_isolation ON "HealthFacility"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Amorçage RLS a la creation (voir application/commands/CreateHealthFacility.ts) : la politique
-- ci-dessus n'a pas de clause WITH CHECK explicite, donc Postgres reutilise la clause USING pour
-- l'INSERT egalement — l'INSERT n'est autorise QUE si `app.tenant_id` (positionne par le
-- UnitOfWork AVANT le premier INSERT, avec l'id genere cote applicatif) correspond deja a
-- `tenant_id` de la ligne inseree. Aucune politique additionnelle n'est necessaire pour ce cas,
-- contrairement au catalogue de roles SYSTEM (Role) qui, lui, s'ecrit sans contexte tenant.

-- Comme pour les autres tables tenant-scoped, le role applicatif `sih_app` beneficie deja des
-- privileges necessaires via `ALTER DEFAULT PRIVILEGES` positionne par la migration
-- 20260823173817_identity_rbac_app_role (portee sur le schema "public" entier, s'applique donc
-- automatiquement a toute nouvelle table creee par le role de migration).
