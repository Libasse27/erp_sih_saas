-- =============================================================================================
-- Role d'execution applicatif, distinct du role de migration.
--
-- Choix conservateur documente, non explicitement demande mais indispensable a la garantie
-- promise par ADR-0001 : le role Postgres cree par `docker-compose.yml` (`sih`, via
-- POSTGRES_USER) est le role bootstrap du cluster PostgreSQL officiel — il est SUPERUSER.
-- Un superuser Postgres **ignore toujours RLS, y compris FORCE ROW LEVEL SECURITY** (c'est un
-- comportement du moteur, non contournable par une politique). Faire tourner l'application
-- (et donc le UnitOfWork/RLS) avec ce role donnerait une illusion d'isolation : les policies
-- seraient presentes mais totalement inoperantes.
--
-- Ce role `sih_app`, NOSUPERUSER et NOBYPASSRLS, est celui que l'application (et les tests
-- d'integration RLS) doivent utiliser via DATABASE_URL. Le role `sih` reste reserve aux
-- migrations (DDL), jamais utilise a l'execution.
-- =============================================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sih_app') THEN
    CREATE ROLE sih_app LOGIN PASSWORD 'sih_app_dev_only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA "platform" TO sih_app;
GRANT USAGE ON SCHEMA "public" TO sih_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "platform" TO sih_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO sih_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA "platform"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sih_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sih_app;
