-- =================================================================================================
-- Etape 5/13 (Phase 0) — Outbox (D9) + Module Payment (Payment / PlatformInvoice, O-25) +
-- extension du cycle de vie Subscription (grace/degrade, O-03).
--
-- Toutes les tables ajoutees ici vivent dans le schema "platform", HORS RLS (ADR-0001 §3.3),
-- meme regime que la migration 20260824090000_subscription_plan_pricing_init : AUCUNE politique
-- RLS, AUCUN "FORCE ROW LEVEL SECURITY". `OutboxMessage` en particulier DOIT rester hors RLS : le
-- relais (shared-kernel/infrastructure/persistence/OutboxRelay.ts) est un processus de niveau
-- plateforme qui lit les messages de TOUS les tenants pour les distribuer.
--
-- Le role applicatif `sih_app` beneficie deja des privileges necessaires sur le schema "platform"
-- via `ALTER DEFAULT PRIVILEGES` (migration 20260823173817_identity_rbac_app_role) — aucun GRANT
-- supplementaire n'est necessaire ici.
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- Outbox generique (D9)
-- -------------------------------------------------------------------------------------------------

CREATE TYPE "platform"."OutboxMessageStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

CREATE TABLE "platform"."OutboxMessage" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "payload" JSONB NOT NULL,
    "status" "platform"."OutboxMessageStatus" NOT NULL DEFAULT 'PENDING',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "processed_at" TIMESTAMP(3),
    "last_error" TEXT,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- Index consulte par chaque cycle de polling du relais (WHERE status = ... ORDER BY occurred_at).
CREATE INDEX "OutboxMessage_status_occurred_at_idx" ON "platform"."OutboxMessage"("status", "occurred_at");

-- -------------------------------------------------------------------------------------------------
-- Extension du cycle de vie Subscription (O-03 : grace 7 jours -> mode degrade 30 jours ->
-- maintien indefini). Ajout de valeurs a un enum existant : autorise dans une transaction sur
-- PostgreSQL 12+ tant que la nouvelle valeur n'est pas utilisee dans la MEME transaction — ce
-- n'est pas le cas ici (aucun INSERT/UPDATE ne reference GRACE_PERIOD/DEGRADED plus bas).
-- -------------------------------------------------------------------------------------------------

ALTER TYPE "platform"."SubscriptionStatus" ADD VALUE 'GRACE_PERIOD';
ALTER TYPE "platform"."SubscriptionStatus" ADD VALUE 'DEGRADED';

ALTER TABLE "platform"."Subscription"
  ADD COLUMN "grace_period_started_at" TIMESTAMP(3),
  ADD COLUMN "degraded_mode_entered_at" TIMESTAMP(3),
  ADD COLUMN "degraded_mode_sustained_notified_at" TIMESTAMP(3);

-- -------------------------------------------------------------------------------------------------
-- Module Payment (O-25) — Payment / PlatformInvoice
-- -------------------------------------------------------------------------------------------------

CREATE TYPE "platform"."PaymentMethod" AS ENUM ('MOBILE_MONEY', 'CARD');
CREATE TYPE "platform"."PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'RENEWED');
CREATE TYPE "platform"."PaymentPurpose" AS ENUM ('INITIAL', 'RENEWAL', 'UPGRADE');
CREATE TYPE "platform"."PlatformInvoiceStatus" AS ENUM ('ISSUED', 'PAID');

CREATE TABLE "platform"."PlatformInvoice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "plan_price_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "period_starts_at" TIMESTAMP(3) NOT NULL,
    "period_ends_at" TIMESTAMP(3) NOT NULL,
    "status" "platform"."PlatformInvoiceStatus" NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "PlatformInvoice_pkey" PRIMARY KEY ("id")
);

-- Barriere d'idempotence pour l'emission concurrente (deux renouvellements concurrents ne peuvent
-- jamais produire deux factures pour la meme periode du meme abonnement).
CREATE UNIQUE INDEX "PlatformInvoice_subscription_id_period_starts_at_key" ON "platform"."PlatformInvoice"("subscription_id", "period_starts_at");
CREATE INDEX "PlatformInvoice_tenant_id_idx" ON "platform"."PlatformInvoice"("tenant_id");

CREATE TABLE "platform"."Payment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "platform_invoice_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "purpose" "platform"."PaymentPurpose" NOT NULL,
    "method" "platform"."PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "platform"."PaymentStatus" NOT NULL,
    "provider_transaction_id" TEXT NOT NULL,
    "initiated_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- Cle d'idempotence webhook imposee par O-25.5 ("idempotence par identifiant de transaction
-- fournisseur") : deux confirmations pour le meme providerTransactionId ne peuvent jamais creer
-- deux lignes Payment distinctes.
CREATE UNIQUE INDEX "Payment_provider_transaction_id_key" ON "platform"."Payment"("provider_transaction_id");
CREATE INDEX "Payment_tenant_id_idx" ON "platform"."Payment"("tenant_id");
CREATE INDEX "Payment_platform_invoice_id_idx" ON "platform"."Payment"("platform_invoice_id");

-- FK INTRA-module uniquement (Payment -> PlatformInvoice, meme module) : voir commentaire en tete
-- de section correspondante dans schema.prisma sur l'absence deliberee de FK vers
-- platform.Subscription (module different).
ALTER TABLE "platform"."Payment"
  ADD CONSTRAINT "Payment_platform_invoice_id_fkey" FOREIGN KEY ("platform_invoice_id") REFERENCES "platform"."PlatformInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Pas de ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY dans cette migration : ces tables restent
-- volontairement hors du garde-fou generique test/tenant/integration/rlsGuard.test.ts (schema
-- "public" uniquement) — voir le commentaire de tete de fichier.
