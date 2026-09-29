-- Pagination keyset de `listByTenant` (GET /api/v1/memberships, module identity) : l'index
-- existant `UserTenantMembership_tenant_id_status_idx` sert le filtre d'egalite (tenant_id,
-- status) mais ne couvre pas `ORDER BY joined_at DESC, id DESC` — un index B-tree ne fournit un
-- ordre que sur SES PROPRES colonnes, dans leur ordre de declaration. Sans cet index dedie,
-- Postgres doit effectuer un tri separe des lignes du tenant a chaque page (en memoire ou sur
-- disque selon le volume). Meme motif que
-- `AuditEntry_tenant_id_occurred_at_id_idx` (migration 20260829090000_audit_platform_extended,
-- module audit) : prefixe tenant_id (ESR : Equality -> Sort -> Range), colonnes de tri en DESC
-- pour correspondre exactement a l'ordre demande par `PrismaUserTenantMembershipRepository.
-- listByTenant`. Index ADDITIONNEL — `UserTenantMembership_tenant_id_status_idx` reste en place,
-- il sert d'autres requetes (countActive, findActiveByUserAndTenant) qui n'ont pas besoin du tri.

CREATE INDEX "UserTenantMembership_tenant_id_joined_at_id_idx"
  ON "UserTenantMembership"("tenant_id", "joined_at" DESC, "id" DESC);
