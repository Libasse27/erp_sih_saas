-- =================================================================================================
-- Etape 7/13 (Phase 0) — Immuabilite de platform.AuditEntry : complement TRUNCATE (correction
-- post-revue independante, finding F-8).
--
-- La migration 20260826150000_mfa_totp_and_audit_entry couvrait deja UPDATE/DELETE (REVOKE +
-- trigger BEFORE UPDATE OR DELETE FOR EACH ROW), mais PAS TRUNCATE : `TRUNCATE` ne declenche
-- jamais un trigger `FOR EACH ROW` (ni meme les triggers BEFORE/AFTER classiques par ligne), et le
-- role applicatif `sih_app` (cree par 20260823173817_identity_rbac_app_role) n'avait recu aucun
-- REVOKE explicite sur ce privilege — `TRUNCATE` etant accorde par defaut au proprietaire de la
-- table (et heritable selon les GRANT anterieurs), un contournement de l'append-only restait
-- possible par cette voie, non couverte par auditEntryImmutability.test.ts jusqu'ici.
--
-- MEME defense en profondeur a DEUX niveaux que la migration precedente :
--   1. REVOKE TRUNCATE pour le role applicatif reel (`sih_app`).
--   2. Un trigger BEFORE TRUNCATE (necessairement FOR EACH STATEMENT — TRUNCATE ne supporte pas
--      FOR EACH ROW) qui leve systematiquement. Reutilise `platform.audit_entry_is_append_only()`
--      (deja definie par la migration precedente) : cette fonction ne reference ni NEW ni OLD,
--      elle est donc valide aussi bien pour un trigger FOR EACH ROW (UPDATE/DELETE) que pour un
--      trigger FOR EACH STATEMENT (TRUNCATE).
--
-- Dette assumee, inchangee (voir migration precedente et ADR-0005 "Consequences") : protege contre
-- le role applicatif et contre l'API, PAS contre un superuser PostgreSQL.
-- =================================================================================================

REVOKE TRUNCATE ON "platform"."AuditEntry" FROM sih_app;

CREATE TRIGGER audit_entry_append_only_truncate
  BEFORE TRUNCATE ON "platform"."AuditEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION platform.audit_entry_is_append_only();
