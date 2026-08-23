-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- CreateEnum
CREATE TYPE "platform"."PlatformRole" AS ENUM ('SUPER_ADMIN', 'NONE');

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('SYSTEM', 'TENANT');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateTable
CREATE TABLE "platform"."UserAccount" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "platform_role" "platform"."PlatformRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."Permission" (
    "code" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "RoleScope" NOT NULL,
    "tenant_id" UUID,
    "permission_codes" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserTenantMembership" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL,
    "left_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,

    CONSTRAINT "UserTenantMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipRole" (
    "id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAccount_email_key" ON "platform"."UserAccount"("email");

-- CreateIndex
CREATE INDEX "Role_tenant_id_idx" ON "Role"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenant_id_code_key" ON "Role"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "UserTenantMembership_tenant_id_status_idx" ON "UserTenantMembership"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "UserTenantMembership_user_id_tenant_id_idx" ON "UserTenantMembership"("user_id", "tenant_id");

-- CreateIndex
CREATE INDEX "MembershipRole_tenant_id_idx" ON "MembershipRole"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipRole_membership_id_role_id_key" ON "MembershipRole"("membership_id", "role_id");

-- AddForeignKey
ALTER TABLE "MembershipRole" ADD CONSTRAINT "MembershipRole_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "UserTenantMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipRole" ADD CONSTRAINT "MembershipRole_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================================
-- Row-Level Security (ADR-0001, couche 4 de la defense en profondeur — "garantie de dernier
-- recours", jamais la seule barriere : chaque repository filtre aussi explicitement par
-- tenant_id, voir apps/api/src/modules/identity/infrastructure/persistence/*).
--
-- Chaque table tenant-scoped de ce module recoit FORCE ROW LEVEL SECURITY (le proprietaire de
-- la table ne peut pas la contourner) + une politique qui exige
-- `tenant_id = current_setting('app.tenant_id', true)::uuid`, positionne par transaction par
-- le UnitOfWork via `select set_config('app.tenant_id', $1, true)` (jamais par interpolation
-- de chaine — voir infrastructure/persistence/PgUnitOfWork.ts).
-- =============================================================================================

-- UserTenantMembership -------------------------------------------------------------------------
ALTER TABLE "UserTenantMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserTenantMembership" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "UserTenantMembership"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Politique additive (permissive : Postgres combine plusieurs politiques permissives pour la
-- meme commande par OR). Un utilisateur authentifie mais pas encore contextualise dans un
-- tenant doit pouvoir lister SES PROPRES memberships actifs pour choisir un etablissement
-- (ecran de selection post-login, O-05) — c'est la SEULE requete transversale aux tenants
-- autorisee dans ce module, et elle reste strictement scopee a
-- `user_id = current_setting('app.user_id', true)::uuid`, jamais a un userId arbitraire fourni
-- par le client. Le UnitOfWork positionne `app.user_id` des que l'identite est connue (voir
-- AuthenticateUser -> listActiveTenantIdsForUser). Si `app.user_id` n'est pas positionne,
-- `current_setting(..., true)` renvoie NULL et cette politique ne laisse passer aucune ligne.
CREATE POLICY self_membership_lookup ON "UserTenantMembership"
  FOR SELECT
  USING (user_id = current_setting('app.user_id', true)::uuid);

-- Unicite d'un membership ACTIF par (user_id, tenant_id) — defense en profondeur en plus du
-- controle applicatif (GrantMembershipHandler verifie deja l'absence de membership actif avant
-- d'en creer un). Un membership REVOKED n'empeche pas un octroi ulterieur (nouvelle ligne),
-- d'ou un index UNIQUE PARTIEL plutot qu'une contrainte globale sur (user_id, tenant_id).
CREATE UNIQUE INDEX "user_tenant_membership_active_unique"
  ON "UserTenantMembership" ("user_id", "tenant_id")
  WHERE "status" = 'ACTIVE';

-- MembershipRole --------------------------------------------------------------------------------
ALTER TABLE "MembershipRole" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MembershipRole" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "MembershipRole"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Role --------------------------------------------------------------------------------------------
-- Table mixte : lignes SYSTEM (tenant_id NULL, catalogue global immuable des 18 roles) +
-- lignes TENANT (personnalisees, isolees par tenant). RLS FORCE s'applique aux deux ; la
-- politique `tenant_isolation` couvre les lignes TENANT, la politique additive
-- `system_role_catalog_read` autorise la lecture des lignes SYSTEM quel que soit le contexte
-- de session (elles n'exposent aucune donnee d'etablissement, seulement un catalogue de
-- permissions global).
ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Role" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "Role"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY system_role_catalog_read ON "Role"
  FOR SELECT
  USING (tenant_id IS NULL AND scope = 'SYSTEM');

-- Ecriture des roles SYSTEM reservee au script de seed d'infrastructure (voir
-- infrastructure/seed/systemRolesSeed.ts), qui s'execute sans `app.tenant_id` positionne : la
-- politique `tenant_isolation` seule bloquerait l'INSERT (`tenant_id IS NULL` ne peut jamais
-- etre egal a `current_setting(...)::uuid`). Une politique FOR INSERT dediee, restreinte aux
-- lignes SYSTEM, evite d'avoir a accorder un role BYPASSRLS a l'application.
CREATE POLICY system_role_catalog_write ON "Role"
  FOR INSERT
  WITH CHECK (tenant_id IS NULL AND scope = 'SYSTEM');

-- Unicite globale des codes de roles SYSTEM (tenant_id NULL) : la contrainte Prisma
-- @@unique([tenantId, code]) ne suffit pas, Postgres traitant chaque NULL comme distinct de
-- tout autre NULL dans une contrainte UNIQUE standard.
CREATE UNIQUE INDEX "role_system_code_unique"
  ON "Role" ("code")
  WHERE "tenant_id" IS NULL;

-- Note : "platform"."UserAccount" et "platform"."Permission" sont des tables de niveau
-- plateforme, delibierement HORS RLS tenant (ADR-0001 §3.2 dernier paragraphe) — c'est la
-- frontiere plateforme/tenant elle-meme, pas une omission de couverture RLS.
