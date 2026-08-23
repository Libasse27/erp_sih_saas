-- =============================================================================================
-- Correctif RLS : `current_setting('app.tenant_id', true)` peut renvoyer une CHAINE VIDE (pas
-- NULL) sur une connexion qui a deja positionne ce parametre custom au moins une fois dans son
-- cycle de vie (le "reset" d'un SET LOCAL en fin de transaction ramene un GUC custom a chaine
-- vide plutot qu'a une valeur reellement indefinie, une fois le placeholder cree pour la
-- session/connexion). Avec du connection pooling (Prisma, PgBouncer), une connexion reutilisee
-- pour une transaction SANS tenant (ex. AuthenticateUser, niveau plateforme) apres une
-- transaction AVEC tenant peut donc se retrouver avec `current_setting(...) = ''`.
--
-- `''::uuid` leve une erreur Postgres (22P02), au lieu d'echouer proprement en filtrant la
-- ligne (comportement attendu d'un GUC "absent"). Sans le NULLIF ci-dessous, une simple lecture
-- de table sans contexte tenant positionne peut planter au lieu de retourner 0 ligne — c'est un
-- risque de disponibilite, pas de confidentialite (aucune fuite n'etait possible : le
-- comportement precedent etait "erreur", jamais "fuite"), mais il degrade la garantie recherchee
-- ("aucune ligne visible par defaut" doit rester silencieux). Ce correctif remplace chaque
-- politique par la forme standard recommandee par la documentation PostgreSQL pour ce cas.
-- =============================================================================================

DROP POLICY IF EXISTS tenant_isolation ON "UserTenantMembership";
CREATE POLICY tenant_isolation ON "UserTenantMembership"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS self_membership_lookup ON "UserTenantMembership";
CREATE POLICY self_membership_lookup ON "UserTenantMembership"
  FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "MembershipRole";
CREATE POLICY tenant_isolation ON "MembershipRole"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "Role";
CREATE POLICY tenant_isolation ON "Role"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
