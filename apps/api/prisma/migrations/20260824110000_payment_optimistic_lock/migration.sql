-- =================================================================================================
-- Etape 5/13 (Phase 0) — Verrouillage optimiste sur platform.Payment (correction post-revue).
--
-- Le webhook de confirmation (ConfirmPaymentHandler) et le rapprochement periodique
-- (ReconcilePendingPaymentsHandler) peuvent tous deux lire puis ecrire le MEME Payment PENDING
-- concurremment (ex. webhook -> SUCCEEDED pendant qu'un cycle de rapprochement, ayant lu PENDING
-- avant ce commit, s'appreterait a ecrire EXPIRED) : sans controle de version, le dernier
-- `UPDATE` gagnant ecraserait silencieusement l'autre (lost update), alors meme qu'un evenement
-- `SaaSPaymentSucceeded` aurait deja ete ecrit dans l'Outbox — incoherence d'audit grave entre la
-- ligne Payment et le reste du systeme.
--
-- Colonne PUREMENT technique (voir PrismaPaymentRepository.ts) : ne modifie NI Subscription NI
-- PlatformInvoice, la race identifiee est strictement entre les deux ecrivains de Payment.
-- =================================================================================================

ALTER TABLE "platform"."Payment" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
