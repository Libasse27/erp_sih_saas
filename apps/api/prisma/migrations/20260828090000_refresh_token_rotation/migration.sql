-- Sessions avancees : refresh token a rotation (Phase 0, etape 8/13, ADR-0006).

-- CreateEnum
CREATE TYPE "platform"."RefreshTokenStatus" AS ENUM ('ACTIVE', 'ROTATED', 'REVOKED');

-- CreateEnum
CREATE TYPE "platform"."RefreshTokenSensitivityCategory" AS ENUM ('PLATFORM_SUPER_ADMIN', 'TENANT_MFA_REQUIRED', 'TENANT_STANDARD');

-- AlterEnum : categorie d'audit SESSION (ADR-0006 §8) — ADD VALUE seul dans cette transaction de
-- migration, jamais utilisee dans le meme fichier (restriction PostgreSQL < 12 conservee par
-- prudence : une valeur ajoutee ne doit pas etre referencee avant le COMMIT de la transaction qui
-- l'ajoute).
ALTER TYPE "platform"."AuditCategory" ADD VALUE 'SESSION';

-- AlterEnum : types d'evenement SESSION (miroir de SessionAuditEventType, ADR-0006 §8).
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SESSION_REFRESH_ROTATED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SESSION_REFRESH_REUSE_DETECTED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SESSION_REFRESH_REVOKED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SESSION_ABSOLUTE_CEILING_EXCEEDED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SESSION_INACTIVITY_TIMEOUT';

-- CreateTable
CREATE TABLE "platform"."RefreshToken" (
    "id" UUID NOT NULL,
    "chain_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID,
    "membership_id" UUID,
    "sensitivity_category" "platform"."RefreshTokenSensitivityCategory" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "platform"."RefreshTokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "session_id" TEXT NOT NULL,
    "previous_token_id" UUID,
    "chain_started_at" TIMESTAMP(3) NOT NULL,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "inactivity_expires_at" TIMESTAMP(3) NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_hash_key" ON "platform"."RefreshToken"("token_hash");

-- CreateIndex
CREATE INDEX "RefreshToken_chain_id_idx" ON "platform"."RefreshToken"("chain_id");

-- CreateIndex
CREATE INDEX "RefreshToken_user_id_idx" ON "platform"."RefreshToken"("user_id");

-- CreateIndex
CREATE INDEX "RefreshToken_membership_id_idx" ON "platform"."RefreshToken"("membership_id");

-- CreateIndex
CREATE INDEX "RefreshToken_session_id_idx" ON "platform"."RefreshToken"("session_id");

-- AddForeignKey
ALTER TABLE "platform"."RefreshToken" ADD CONSTRAINT "RefreshToken_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform"."UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Pas de ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY : "platform"."RefreshToken" vit hors RLS
-- par construction (ADR-0006 §4, meme regime que MfaEnrollment/AuditEntry) — voir
-- test/tenant/integration/rlsGuard.test.ts (PLATFORM_TABLES_WITHOUT_RLS), mis a jour par cette
-- meme etape.
