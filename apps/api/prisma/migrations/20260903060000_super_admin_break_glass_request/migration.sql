-- ADR-0005 Amendement 1 (2026-09-03, O-04 residu 4) : recuperation break-glass d'un SUPER_ADMIN
-- qui a perdu son facteur TOTP et epuise ses codes de recuperation -- jusqu'ici un verrouillage
-- DEFINITIF, sans mecanisme de contournement (voir ADR-0005, Residus original, point 4).
-- Table hors RLS (concept d'administration plateforme, jamais tenant-scope) -- meme regime que
-- "platform"."RefreshToken"/"platform"."MfaEnrollment". Aucune contrainte FK vers UserAccount
-- (meme raisonnement que "platform"."AuditEntry" : trois references distinctes a la meme table
-- nommeraient trois relations, et cette table ne doit jamais cascade-supprimer avec un compte).
CREATE TYPE "platform"."SuperAdminBreakGlassRequestStatus" AS ENUM ('PENDING', 'APPROVED');

CREATE TABLE "platform"."SuperAdminBreakGlassRequest" (
    "id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "subject_user_account_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "platform"."SuperAdminBreakGlassRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by_user_id" UUID,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),

    CONSTRAINT "SuperAdminBreakGlassRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SuperAdminBreakGlassRequest_subject_user_account_id_idx" ON "platform"."SuperAdminBreakGlassRequest"("subject_user_account_id");

CREATE INDEX "SuperAdminBreakGlassRequest_status_idx" ON "platform"."SuperAdminBreakGlassRequest"("status");
