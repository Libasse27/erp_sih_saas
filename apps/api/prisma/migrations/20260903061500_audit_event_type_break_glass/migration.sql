-- ADR-0005 Amendement 1 (2026-09-03, O-04 residu 4) : deux nouvelles valeurs d'AuditEventType pour
-- le break-glass SUPER_ADMIN. `ALTER TYPE ... ADD VALUE` ne peut jamais etre suivi, dans la MEME
-- transaction, d'une requete qui utilise la nouvelle valeur (limite Postgres, meme regime que
-- 20260829090000_audit_platform_extended) -- migration separee, uniquement ces deux instructions.
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SUPER_ADMIN_BREAK_GLASS_REQUESTED';
ALTER TYPE "platform"."AuditEventType" ADD VALUE 'SUPER_ADMIN_BREAK_GLASS_APPROVED';
