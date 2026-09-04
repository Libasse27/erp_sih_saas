-- ADR-0005 Amendement 1 (2026-09-03, O-04 residu 4) : deux nouvelles valeurs de
-- NotificationTemplateKind pour l'alerte immediate aux autres SUPER_ADMIN (ouverture ET
-- approbation d'une demande de recuperation break-glass). `ALTER TYPE ... ADD VALUE` ne peut
-- jamais etre suivi, dans la MEME transaction, d'une requete qui utilise la nouvelle valeur (limite
-- Postgres, meme regime que 20260903061500_audit_event_type_break_glass) -- migration separee,
-- uniquement ces deux instructions.
ALTER TYPE "platform"."NotificationTemplateKind" ADD VALUE 'SUPER_ADMIN_BREAK_GLASS_REQUESTED';
ALTER TYPE "platform"."NotificationTemplateKind" ADD VALUE 'SUPER_ADMIN_BREAK_GLASS_APPROVED';
