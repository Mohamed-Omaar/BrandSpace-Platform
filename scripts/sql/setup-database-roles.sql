-- ===========================================================================
-- BrandSpace — database role setup.
--
-- THREE ROLES, with deliberately different powers. This file is the canonical
-- definition; CI and local setup both use it, so the roles cannot drift.
--
--   brandspace_migrator  owns the schema, runs migrations (DDL). Never serves a
--                        request. NOBYPASSRLS.
--   brandspace_app       serves every tenant request. NOBYPASSRLS, owns nothing,
--                        and NO RLS policy grants it cross-tenant visibility.
--   brandspace_platform  serves audited platform operations only. NOBYPASSRLS —
--                        its cross-tenant access comes from role-targeted RLS
--                        policies, not from a privilege that skips policy
--                        evaluation entirely.
--
-- WHY THIS IS SAFE (docs/SECURITY.md §2.4):
--   Cross-tenant visibility is a property of WHICH ROLE CONNECTED, decided by
--   the credential in the connection string. It is no longer a session variable
--   the application can set. brandspace_app cannot obtain platform visibility by
--   any SQL it can execute: it is not a member of brandspace_platform, so SET
--   ROLE fails, and no policy names it.
--
-- Passwords are supplied by the caller via psql variables and are never stored
-- in this file:
--   psql -v migrator_password=... -v app_password=... -v platform_password=... \
--        -f scripts/sql/setup-database-roles.sql
-- ===========================================================================

\set ON_ERROR_STOP on

-- --------------------------------------------------------------------------
-- Roles
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brandspace_migrator') THEN
    CREATE ROLE brandspace_migrator LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brandspace_app') THEN
    CREATE ROLE brandspace_app LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brandspace_platform') THEN
    CREATE ROLE brandspace_platform LOGIN NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE brandspace_migrator WITH PASSWORD :'migrator_password';
ALTER ROLE brandspace_app      WITH PASSWORD :'app_password';
ALTER ROLE brandspace_platform WITH PASSWORD :'platform_password';

-- The migrator is the DDL identity, so it must own the schema it migrates.
--
-- CI creates each test database WITH OWNER brandspace_migrator, which makes this
-- true implicitly through PostgreSQL's pg_database_owner default. Railway
-- provisions the database first under its own owner, so creating the role alone
-- is not enough there: Prisma reaches the database but cannot create
-- _prisma_migrations in public. Make the documented contract explicit in every
-- environment instead of depending on how the database happened to be created.
ALTER SCHEMA public OWNER TO brandspace_migrator;

-- None of the three may ever bypass row-level security.
ALTER ROLE brandspace_migrator NOBYPASSRLS NOSUPERUSER;
ALTER ROLE brandspace_app      NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE brandspace_platform NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- CREATEDB only for the migrator, and only so Prisma can build its shadow
-- database during `migrate dev`. Use a dedicated shadow URL in staging and
-- production instead (docs/DECISIONS.md F-03).
ALTER ROLE brandspace_migrator CREATEDB;

-- --------------------------------------------------------------------------
-- THE CRITICAL NEGATIVE GRANT.
--
-- brandspace_app is deliberately NOT a member of brandspace_platform, so
-- `SET ROLE brandspace_platform` fails for it. Revoking explicitly documents
-- the intent and repairs any environment where it was granted by mistake.
-- --------------------------------------------------------------------------
REVOKE brandspace_platform FROM brandspace_app;
REVOKE brandspace_app      FROM brandspace_platform;
REVOKE brandspace_migrator FROM brandspace_app;
REVOKE brandspace_migrator FROM brandspace_platform;

-- --------------------------------------------------------------------------
-- Verification. Fails loudly rather than leaving a weak environment in place.
-- --------------------------------------------------------------------------
DO $
DECLARE
  offending text;
  schema_owner text;
BEGIN
  SELECT string_agg(rolname, ', ') INTO offending
    FROM pg_roles
   WHERE rolname IN ('brandspace_app', 'brandspace_platform', 'brandspace_migrator')
     AND (rolsuper OR rolbypassrls);
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Roles must not be superuser or BYPASSRLS: %', offending;
  END IF;

  IF pg_has_role('brandspace_app', 'brandspace_platform', 'MEMBER') THEN
    RAISE EXCEPTION
      'brandspace_app is a member of brandspace_platform; it could SET ROLE into the platform identity.';
  END IF;

  SELECT pg_get_userbyid(nspowner) INTO schema_owner
    FROM pg_namespace
   WHERE nspname = 'public';

  IF schema_owner IS DISTINCT FROM 'brandspace_migrator' THEN
    RAISE EXCEPTION
      'public schema must be owned by brandspace_migrator, found %',
      COALESCE(schema_owner, '<missing>');
  END IF;
END
$;
