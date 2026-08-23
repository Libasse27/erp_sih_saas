-- =============================================================================================
-- Correctif : le seed du catalogue systeme (seedIdentityCatalog.ts) fait un UPSERT (INSERT ...
-- ON CONFLICT DO UPDATE) pour rester idempotent. Postgres RLS evalue alors a la fois le
-- chemin INSERT et le chemin UPDATE de la commande, meme si en pratique un seul s'execute a
-- l'issue du conflit. La politique precedente `system_role_catalog_write` ne couvrait que
-- l'INSERT (`FOR INSERT`) : le chemin UPDATE echouait avec "new row violates row-level
-- security policy". Remplacee par une politique couvrant explicitement l'ecriture (INSERT et
-- UPDATE) des lignes SYSTEM, toujours restreinte a `tenant_id IS NULL AND scope = 'SYSTEM'` —
-- aucun elargissement de perimetre, seulement les commandes couvertes.
-- =============================================================================================

DROP POLICY IF EXISTS system_role_catalog_write ON "Role";

CREATE POLICY system_role_catalog_insert ON "Role"
  FOR INSERT
  WITH CHECK (tenant_id IS NULL AND scope = 'SYSTEM');

CREATE POLICY system_role_catalog_update ON "Role"
  FOR UPDATE
  USING (tenant_id IS NULL AND scope = 'SYSTEM')
  WITH CHECK (tenant_id IS NULL AND scope = 'SYSTEM');
