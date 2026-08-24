-- =================================================================================================
-- Module Subscription (Phase 0, etape 4/13) — Plan / PlanPrice / Subscription / SubscriptionPlanChange.
--
-- Toutes ces tables vivent dans le schema "platform", conformement a ADR-0001 §3.3 :
-- "Les donnees de niveau plateforme vivent dans un schema platform distinct, hors RLS tenant" —
-- abonnements et forfaits sont cites nommement dans cette decision. AUCUNE POLITIQUE RLS,
-- AUCUN "FORCE ROW LEVEL SECURITY" n'est ajoute sur ces tables, contrairement aux migrations
-- du schema "public" (voir 20260824080000_tenant_health_facility_init/migration.sql pour
-- comparaison) : ce serait contraire a la conception actee pour le schema "platform".
--
-- `Subscription` et `SubscriptionPlanChange` portent tout de meme `tenant_id` : ce n'est PAS un
-- oubli d'y ajouter du RLS, c'est un choix documente. Leur isolation inter-tenant est PUREMENT
-- APPLICATIVE — chaque methode de `PrismaSubscriptionRepository` / `PrismaPlanChangeRepository`
-- filtre explicitement par `tenant_id` (couche 3 de la defense en profondeur, ADR-0001 §3.2),
-- c'est la SEULE barriere reelle sur ces deux tables. Prouve par
-- test/subscription/integration/subscriptionRepositoryTenantIsolation.test.ts.
--
-- Le role applicatif `sih_app` beneficie deja des privileges necessaires sur le schema
-- "platform" via `ALTER DEFAULT PRIVILEGES` positionne par la migration
-- 20260823173817_identity_rbac_app_role (portee sur le schema "platform" entier) — aucun GRANT
-- supplementaire n'est necessaire ici.
-- =================================================================================================

-- CreateEnum
CREATE TYPE "platform"."PlanCode" AS ENUM ('STANDARD', 'PROFESSIONNEL', 'COMPLET');
CREATE TYPE "platform"."BillingPeriod" AS ENUM ('MENSUEL', 'ANNUEL');
CREATE TYPE "platform"."SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE');
CREATE TYPE "platform"."SubscriptionPlanChangeType" AS ENUM ('UPGRADE');

-- CreateTable
CREATE TABLE "platform"."Plan" (
    "id" UUID NOT NULL,
    "code" "platform"."PlanCode" NOT NULL,
    "name" TEXT NOT NULL,
    "max_users" INTEGER NOT NULL,
    "max_beds" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plan_code_key" ON "platform"."Plan"("code");

-- CreateTable
CREATE TABLE "platform"."PlanPrice" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "period" "platform"."BillingPeriod" NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanPrice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlanPrice_plan_id_period_effective_from_idx" ON "platform"."PlanPrice"("plan_id", "period", "effective_from");

ALTER TABLE "platform"."PlanPrice"
  ADD CONSTRAINT "PlanPrice_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform"."Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "platform"."Subscription" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "current_plan_price_id" UUID NOT NULL,
    "period" "platform"."BillingPeriod" NOT NULL,
    "status" "platform"."SubscriptionStatus" NOT NULL,
    "trial_ends_at" TIMESTAMP(3),
    "period_starts_at" TIMESTAMP(3) NOT NULL,
    "period_ends_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- Invariant "un Tenant a exactement un Subscription a un instant donne" (01-target-architecture.md
-- §6.3) impose au niveau base, en plus de la verification applicative dans les handlers.
CREATE UNIQUE INDEX "Subscription_tenant_id_key" ON "platform"."Subscription"("tenant_id");

ALTER TABLE "platform"."Subscription"
  ADD CONSTRAINT "Subscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform"."Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform"."Subscription"
  ADD CONSTRAINT "Subscription_current_plan_price_id_fkey" FOREIGN KEY ("current_plan_price_id") REFERENCES "platform"."PlanPrice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "platform"."SubscriptionPlanChange" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "change_type" "platform"."SubscriptionPlanChangeType" NOT NULL,
    "from_plan_id" UUID NOT NULL,
    "from_plan_price_id" UUID NOT NULL,
    "to_plan_id" UUID NOT NULL,
    "to_plan_price_id" UUID NOT NULL,
    "prorated_amount" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlanChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SubscriptionPlanChange_subscription_id_idx" ON "platform"."SubscriptionPlanChange"("subscription_id");
CREATE INDEX "SubscriptionPlanChange_tenant_id_idx" ON "platform"."SubscriptionPlanChange"("tenant_id");

ALTER TABLE "platform"."SubscriptionPlanChange"
  ADD CONSTRAINT "SubscriptionPlanChange_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "platform"."Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform"."SubscriptionPlanChange"
  ADD CONSTRAINT "SubscriptionPlanChange_from_plan_id_fkey" FOREIGN KEY ("from_plan_id") REFERENCES "platform"."Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform"."SubscriptionPlanChange"
  ADD CONSTRAINT "SubscriptionPlanChange_to_plan_id_fkey" FOREIGN KEY ("to_plan_id") REFERENCES "platform"."Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform"."SubscriptionPlanChange"
  ADD CONSTRAINT "SubscriptionPlanChange_from_plan_price_id_fkey" FOREIGN KEY ("from_plan_price_id") REFERENCES "platform"."PlanPrice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform"."SubscriptionPlanChange"
  ADD CONSTRAINT "SubscriptionPlanChange_to_plan_price_id_fkey" FOREIGN KEY ("to_plan_price_id") REFERENCES "platform"."PlanPrice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Pas de ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY dans cette migration : voir le
-- commentaire de tete de fichier (ADR-0001 §3.3). Ces quatre tables restent volontairement hors
-- du garde-fou generique test/tenant/integration/rlsGuard.test.ts, qui n'enumere QUE le schema
-- "public" — cette exclusion est correcte et attendue, pas une lacune du garde-fou.
