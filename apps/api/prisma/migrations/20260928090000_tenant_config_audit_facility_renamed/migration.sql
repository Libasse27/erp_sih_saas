-- Phase 1, premier increment vertical (permission `tenant-config:administer`, deja declaree au
-- catalogue mais jusqu'ici inutilisee par aucune route) : consultation et renommage de l'identite
-- de l'etablissement (`HealthFacility.rename()`). Deux nouvelles valeurs d'enumeration
-- STRICTEMENT ADDITIVES, chacune dans sa propre instruction (`ALTER TYPE ... ADD VALUE` ne peut
-- jamais etre suivi, dans la MEME transaction, d'une requete qui utilise la nouvelle valeur —
-- limite PostgreSQL, meme discipline que 20260903061500_audit_event_type_break_glass).
--
-- Aucune colonne, aucun index, aucune contrainte modifiee : ce renommage reutilise integralement
-- les colonnes existantes de `platform.AuditEntry` (ADR-0009), `target_type` restant `HEALTH_FACILITY`
-- (deja present, aucune migration necessaire).
ALTER TYPE "platform"."AuditCategory" ADD VALUE 'TENANT_CONFIG';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'TENANT_CONFIG_FACILITY_RENAMED';
