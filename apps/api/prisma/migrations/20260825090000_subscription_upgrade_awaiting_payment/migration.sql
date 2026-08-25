-- =================================================================================================
-- Passe 2 (etapes 4+5, retro-branchement) — L'upgrade proratise devient CONDITIONNE a un paiement
-- reellement confirme (O-02.6 + O-25).
--
-- Avant : `UpgradeSubscriptionPlanHandler` appliquait le changement de forfait IMMEDIATEMENT et
-- GRATUITEMENT (aucune PlatformInvoice, aucun Payment). Apres :
--   Upgrade demande -> prorata calcule -> PlanUpgradeRequest (attente) + PlatformInvoice(UPGRADE)
--   -> Payment PENDING -> confirmation serveur (webhook/rapprochement) -> application effective.
-- En cas d'echec/expiration, l'ancien forfait reste actif : jamais d'activation partielle.
--
-- Correlation cross-module SANS import de domaine croise (dependency-cruiser
-- `no-cross-module-domain-import`) : une reference OPAQUE (`source_reference` = le PlanChangeId
-- pre-attribue cote `subscription`) circule via les payloads d'evenements Outbox. Le module
-- `payment` ne connait de cette chaine que "la reference du fait metier a l'origine de cette
-- facture" — aucun concept `plan`/`upgrade` ne fuit dans son schema.
-- =================================================================================================

-- -------------------------------------------------------------------------------------------------
-- 1. Verrouillage optimiste sur platform.Subscription (replique EXACTE du pattern deja en place sur
--    platform.Payment, migration 20260824110000). Necessaire des maintenant : l'application d'un
--    upgrade (consommateur Outbox `ApplyPlanUpgradeOnPaymentSucceeded`), la reactivation sur
--    paiement (`ReactivateSubscriptionOnPaymentSucceeded`) et le scheduler de renouvellement
--    (`ProcessSubscriptionRenewals`) peuvent desormais lire puis ecrire le MEME Subscription
--    concurremment — sans controle de version, le dernier UPDATE gagnant ecraserait silencieusement
--    l'autre (lost update) alors qu'un evenement aurait deja ete ecrit dans l'Outbox.
--    Colonne PUREMENT technique : absente de SubscriptionProps, connue du seul repository.
-- -------------------------------------------------------------------------------------------------
ALTER TABLE "platform"."Subscription" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- -------------------------------------------------------------------------------------------------
-- 2. platform.SubscriptionPlanChange — l'historique porte desormais la date de DEMANDE (distincte
--    de la date d'APPLICATION, `occurred_at`, qui n'a plus lieu au meme instant) et la facture
--    plateforme qui a paye cet upgrade.
--
--    `requested_at` NULLABLE + backfill = `occurred_at` : pour les lignes de l'etape 4, demande et
--    application etaient effectivement simultanees, la valeur est donc exacte, pas une valeur de
--    remplissage arbitraire.
--
--    `platform_invoice_id` SANS FOREIGN KEY : regle du depot — aucune contrainte cross-module en
--    base (`PlatformInvoice` appartient au module `payment`), meme discipline que
--    `Payment.subscription_id` cote payment.
-- -------------------------------------------------------------------------------------------------
ALTER TABLE "platform"."SubscriptionPlanChange" ADD COLUMN "requested_at" TIMESTAMP(3);
UPDATE "platform"."SubscriptionPlanChange" SET "requested_at" = "occurred_at" WHERE "requested_at" IS NULL;
ALTER TABLE "platform"."SubscriptionPlanChange" ADD COLUMN "platform_invoice_id" UUID;

-- -------------------------------------------------------------------------------------------------
-- 3. platform.SubscriptionPlanUpgradeRequest — demande d'upgrade EN ATTENTE DE PAIEMENT.
--
--    `id` = le PlanChangeId PRE-ATTRIBUE a la demande : c'est lui qui voyage comme
--    `source_reference` jusqu'a la facture puis revient dans `SaaSPaymentSucceeded`, et c'est lui
--    qui deviendra l'id de la ligne `SubscriptionPlanChange` a l'application.
--
--    `subscription_id` UNIQUE : LA barriere anti-double-clic / double-soumission. Une seule demande
--    d'upgrade en attente par abonnement, imposee par la base et non par une verification
--    applicative sujette a une course.
--
--    AUCUNE colonne `status` : la PRESENCE de la ligne EST le fait "upgrade en attente". Elle est
--    supprimee a l'application — l'historique definitif est `SubscriptionPlanChange`, jamais cette
--    table.
--
--    Schema `platform`, HORS RLS (ADR-0001 §3.3) comme le reste du module : `tenant_id` colonne
--    simple, filtrage PUREMENT applicatif dans le repository.
-- -------------------------------------------------------------------------------------------------
CREATE TABLE "platform"."SubscriptionPlanUpgradeRequest" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_plan_id" UUID NOT NULL,
    "from_plan_price_id" UUID NOT NULL,
    "to_plan_id" UUID NOT NULL,
    "to_plan_price_id" UUID NOT NULL,
    "prorated_amount" INTEGER NOT NULL,
    "covered_period_starts_at" TIMESTAMP(3) NOT NULL,
    "covered_period_ends_at" TIMESTAMP(3) NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlanUpgradeRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionPlanUpgradeRequest_subscription_id_key" ON "platform"."SubscriptionPlanUpgradeRequest"("subscription_id");
CREATE INDEX "SubscriptionPlanUpgradeRequest_tenant_id_idx" ON "platform"."SubscriptionPlanUpgradeRequest"("tenant_id");

-- -------------------------------------------------------------------------------------------------
-- 4. platform.PlatformInvoice — deux chemins d'emission distincts desormais (renouvellement et
--    upgrade), qui doivent pouvoir coexister pour le MEME abonnement sur la MEME periode.
--
--    `purpose` NOT NULL, backfill 'RENEWAL' : avant cette passe, le renouvellement/l'echeance etait
--    le SEUL chemin d'emission (voir IssuePlatformInvoiceOnRenewalDue.ts) — la valeur backfillee
--    est donc exacte pour 100 % des lignes existantes.
--
--    `source_reference` TEXT NULL UNIQUE : reference opaque du fait metier a l'origine de la
--    facture (ici le PlanChangeId d'un upgrade). En PostgreSQL, les NULL ne collisionnent JAMAIS
--    entre eux dans un index UNIQUE : zero impact sur les factures de renouvellement, qui restent
--    toutes a NULL. C'est cette contrainte qui rend `IssuePlatformInvoiceOnUpgradeRequested`
--    idempotent par construction face a une re-livraison Outbox at-least-once.
--
--    `(subscription_id, purpose, period_starts_at)` remplace `(subscription_id, period_starts_at)` :
--    GENERALISATION STRICTE — `purpose` etant constant a 'RENEWAL' sur tout le chemin de
--    renouvellement, la nouvelle cle y est rigoureusement equivalente a l'ancienne (aucun
--    changement de comportement pour IssuePlatformInvoiceOnRenewalDue.ts ni pour son test
--    adversarial d'emission concurrente). Elle autorise en revanche une facture d'UPGRADE a
--    coexister avec la facture de RENOUVELLEMENT de la meme periode — ce que l'ancienne cle
--    interdisait.
-- -------------------------------------------------------------------------------------------------
CREATE TYPE "platform"."PlatformInvoicePurpose" AS ENUM ('RENEWAL', 'UPGRADE');

ALTER TABLE "platform"."PlatformInvoice" ADD COLUMN "purpose" "platform"."PlatformInvoicePurpose";
UPDATE "platform"."PlatformInvoice" SET "purpose" = 'RENEWAL' WHERE "purpose" IS NULL;
ALTER TABLE "platform"."PlatformInvoice" ALTER COLUMN "purpose" SET NOT NULL;

ALTER TABLE "platform"."PlatformInvoice" ADD COLUMN "source_reference" TEXT;
CREATE UNIQUE INDEX "PlatformInvoice_source_reference_key" ON "platform"."PlatformInvoice"("source_reference");

DROP INDEX "platform"."PlatformInvoice_subscription_id_period_starts_at_key";
CREATE UNIQUE INDEX "PlatformInvoice_subscription_id_purpose_period_starts_at_key" ON "platform"."PlatformInvoice"("subscription_id", "purpose", "period_starts_at");
