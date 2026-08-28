-- =============================================================================================
-- Module Tenant — FacilitySettings (ADR-0008 §10/§11, amendement 1, Phase 0 etape 10/13).
--
-- Configuration technique minimale semee en fin de Saga de provisioning : parametres regionaux
-- (fr-SN/Africa/Dakar/XOF/+221) + marqueur d'idempotence `provisioning_completed_at` pour la
-- derniere etape de la Saga. AUCUN CONTENU METIER HOSPITALIER.
--
-- Schema "public" (comme HealthFacility, PAS "platform") : cette table est tenant-scoped au sens
-- ou `tenant_id` REFERENCE un tenant distinct de la ligne (contrairement a HealthFacility, ou
-- id = tenant_id) — RLS FORCE requise, meme discipline que le reste du schema "public"
-- (voir test/tenant/integration/rlsGuard.test.ts, garde-fou generique).
-- =============================================================================================

-- CreateTable
CREATE TABLE "FacilitySettings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "phone_country_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "provisioning_completed_at" TIMESTAMP(3),

    CONSTRAINT "FacilitySettings_pkey" PRIMARY KEY ("id")
);

-- Invariant "au plus une configuration par tenant" impose au niveau base, en plus du controle
-- applicatif (SeedFacilityConfigurationHandler verifie deja l'absence avant creation).
CREATE UNIQUE INDEX "FacilitySettings_tenant_id_key" ON "FacilitySettings"("tenant_id");

-- Row-Level Security (ADR-0001, couche 4 de la defense en profondeur) — forme NULLIF standard
-- (voir migration 20260823174630_identity_rbac_rls_nullif_fix pour l'explication complete),
-- identique a HealthFacility/UserTenantMembership.
ALTER TABLE "FacilitySettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FacilitySettings" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "FacilitySettings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Le role applicatif `sih_app` beneficie deja des privileges necessaires via
-- `ALTER DEFAULT PRIVILEGES` positionne par la migration 20260823173817_identity_rbac_app_role
-- (portee sur le schema "public" entier) — aucun GRANT supplementaire n'est necessaire ici.
