-- =================================================================================================
-- Etape 6/13 (Phase 0) — Outbox + evenements + idempotence (D9, ADR-0004).
--
-- Cette migration n'ajoute AUCUNE colonne a "platform"."OutboxMessage" : le relais migre vers
-- BullMQ (ADR-0004) sans changer le contrat de cette table (status/attempts/locked_at/locked_by
-- restent la source de verite de la reprise apres crash et du dead-letter, voir le commentaire de
-- tete de section correspondant dans schema.prisma). Elle ajoute uniquement le registre GENERIQUE
-- d'idempotence consommateur exige par D9 ("cle d'idempotence + registre des evenements traites").
--
-- Meme regime que "platform"."OutboxMessage" : schema "platform", HORS RLS (ADR-0001 §3.3) — ce
-- registre est lu/ecrit par un composant de niveau plateforme (le wrapper generique invoque par le
-- worker Outbox), jamais par un module applicatif directement.
-- =================================================================================================

CREATE TABLE "platform"."OutboxConsumedEvent" (
    "outbox_message_id" UUID NOT NULL,
    "handler_name" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxConsumedEvent_pkey" PRIMARY KEY ("outbox_message_id", "handler_name")
);

-- FK INTRA-shared-kernel (ce registre et l'Outbox lui-meme sont tous deux des composants
-- transverses, pas des tables appartenant a un module metier — voir le commentaire en tete de
-- schema.prisma sur l'absence de FK CROSS-MODULE, qui ne s'applique pas ici).
ALTER TABLE "platform"."OutboxConsumedEvent"
  ADD CONSTRAINT "OutboxConsumedEvent_outbox_message_id_fkey" FOREIGN KEY ("outbox_message_id") REFERENCES "platform"."OutboxMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Pas de ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY ici : cette table reste volontairement
-- hors du garde-fou generique test/tenant/integration/rlsGuard.test.ts (schema "public"
-- uniquement), meme raisonnement que "platform"."OutboxMessage".
