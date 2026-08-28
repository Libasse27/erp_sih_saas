-- Module notifications : Email + SMS (Phase 0, etape 9/13, O-07, ADR-0007).

-- CreateEnum
CREATE TYPE "platform"."NotificationChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "platform"."NotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "platform"."NotificationTemplateKind" AS ENUM ('SUBSCRIPTION_WELCOME', 'SUBSCRIPTION_PLAN_CHANGED');

-- CreateTable
CREATE TABLE "platform"."Notification" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "channel" "platform"."NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "template_kind" "platform"."NotificationTemplateKind" NOT NULL,
    "source_event_id" UUID NOT NULL,
    "status" "platform"."NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "provider_message_id" TEXT,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_source_event_id_channel_recipient_key" ON "platform"."Notification"("source_event_id", "channel", "recipient");

-- CreateIndex
CREATE INDEX "Notification_tenant_id_idx" ON "platform"."Notification"("tenant_id");

-- CreateIndex
CREATE INDEX "Notification_status_locked_at_idx" ON "platform"."Notification"("status", "locked_at");

-- Pas de ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY : "platform"."Notification" vit hors RLS
-- par construction (ADR-0007 §6, meme regime que Payment/PlatformInvoice) — voir
-- test/tenant/integration/rlsGuard.test.ts (PLATFORM_TABLES_WITHOUT_RLS), mis a jour par cette
-- meme etape.
