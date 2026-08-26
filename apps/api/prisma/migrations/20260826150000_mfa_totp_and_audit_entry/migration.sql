-- CreateEnum
CREATE TYPE "platform"."MfaEnrollmentStatus" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'RESET_REQUIRED');

-- CreateEnum
CREATE TYPE "platform"."MfaFactorType" AS ENUM ('TOTP');

-- CreateEnum
CREATE TYPE "platform"."AuditCategory" AS ENUM ('MFA');

-- CreateEnum
CREATE TYPE "platform"."AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateEnum
CREATE TYPE "platform"."AuditEventType" AS ENUM ('MFA_ENROLLMENT_STARTED', 'MFA_ENROLLMENT_CONFIRMED', 'MFA_FACTOR_REPLACED', 'MFA_CHALLENGE_SUCCEEDED', 'MFA_CHALLENGE_FAILED', 'MFA_CHALLENGE_BLOCKED', 'MFA_BYPASS_ATTEMPTED', 'MFA_RECOVERY_CODE_CONSUMED', 'MFA_RECOVERY_CODES_EXHAUSTED', 'MFA_RECOVERY_CODES_REGENERATED', 'MFA_RE_ENROLLMENT_FORCED', 'MFA_FACTOR_LOCKED_OUT');

-- NOTE (ecart deliberement corrige) : `prisma migrate dev` avait initialement genere ici six
-- instructions `DROP CONSTRAINT` sur PlanPrice/Subscription/SubscriptionPlanChange. Ces FK ont
-- ete ajoutees A LA MAIN en SQL brut par des migrations anterieures (voir schema.prisma, section
-- "Module Subscription" : "Aucune contrainte FOREIGN KEY declaree via @relation Prisma... choix
-- deliberement minimal... integrite referentielle appliquee a la main en migration SQL") — elles
-- n'ont donc jamais ete connues du schema Prisma lui-meme. L'algorithme de diff de
-- `prisma migrate dev` les propose neanmoins a la suppression pour "reconcilier" le schema Prisma
-- et l'etat reel de la base. SUPPRIME ICI VOLONTAIREMENT : ce n'est PAS un changement demande par
-- cette etape (MFA + audit), et les laisser aurait romp l'integrite referentielle deja actee.

-- CreateTable
CREATE TABLE "platform"."MfaEnrollment" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "platform"."MfaEnrollmentStatus" NOT NULL,
    "factor_type" "platform"."MfaFactorType" NOT NULL,
    "active_secret" TEXT,
    "pending_secret" TEXT,
    "last_accepted_time_step" INTEGER,
    "consecutive_failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MfaEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."MfaRecoveryCode" (
    "id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."AuditEntry" (
    "id" UUID NOT NULL,
    "category" "platform"."AuditCategory" NOT NULL,
    "event_type" "platform"."AuditEventType" NOT NULL,
    "outcome" "platform"."AuditOutcome" NOT NULL,
    "tenant_id" UUID,
    "subject_user_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "actor_role_codes" TEXT[],
    "reason" TEXT,
    "session_id" TEXT,
    "correlation_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaEnrollment_user_id_key" ON "platform"."MfaEnrollment"("user_id");

-- CreateIndex
CREATE INDEX "MfaRecoveryCode_enrollment_id_idx" ON "platform"."MfaRecoveryCode"("enrollment_id");

-- CreateIndex
CREATE INDEX "AuditEntry_tenant_id_idx" ON "platform"."AuditEntry"("tenant_id");

-- CreateIndex
CREATE INDEX "AuditEntry_subject_user_id_idx" ON "platform"."AuditEntry"("subject_user_id");

-- AddForeignKey
ALTER TABLE "platform"."MfaEnrollment" ADD CONSTRAINT "MfaEnrollment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform"."UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."MfaRecoveryCode" ADD CONSTRAINT "MfaRecoveryCode_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "platform"."MfaEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =================================================================================================
-- Immuabilite de platform.AuditEntry (ADR-0005 §5, O-04.7) — DEUX defenses independantes :
--   1. REVOKE UPDATE/DELETE pour le role applicatif reel (`sih_app`, cree par la migration
--      20260823173817_identity_rbac_app_role — jamais le role superuser `sih` utilise pour les
--      migrations elles-memes, verifie par grep sur les migrations existantes avant d'ecrire ceci).
--   2. Un trigger BEFORE UPDATE OR DELETE qui leve systematiquement — defense supplementaire
--      INDEPENDANTE du GRANT ci-dessus (un futur GRANT accidentel ne suffirait pas a lui seul a
--      rendre la table mutable).
-- Dette assumee et documentee (ADR-0005 "Consequences") : ceci protege contre le role applicatif
-- et contre l'API, PAS contre un superuser PostgreSQL, qui pourrait supprimer le trigger.
-- =================================================================================================

REVOKE UPDATE, DELETE ON "platform"."AuditEntry" FROM sih_app;

CREATE OR REPLACE FUNCTION platform.audit_entry_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform.AuditEntry est append-only : UPDATE/DELETE interdits (O-04.7).';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_entry_append_only
  BEFORE UPDATE OR DELETE ON "platform"."AuditEntry"
  FOR EACH ROW EXECUTE FUNCTION platform.audit_entry_is_append_only();

-- Pas de ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY dans cette migration : `MfaEnrollment`,
-- `MfaRecoveryCode` et `AuditEntry` vivent toutes trois dans le schema "platform", HORS RLS par
-- construction (ADR-0005 §1/§5) — voir test/tenant/integration/rlsGuard.test.ts
-- (PLATFORM_TABLES_WITHOUT_RLS), mis a jour par cette meme etape.
