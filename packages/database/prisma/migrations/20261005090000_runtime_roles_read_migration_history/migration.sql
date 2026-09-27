-- ---------------------------------------------------------------------------
-- THE RUNTIME ROLES READ THE MIGRATION HISTORY, AND ONLY READ IT.
--
-- WHY. Every application service now refuses to report ready until the
-- database has every migration its build was made with (readiness gate,
-- docs/RAILWAY-DEPLOYMENT.md §4.4). The api and the worker run as
-- `brandspace_app`, the Control Center as `brandspace_platform`; each reads
-- `_prisma_migrations` to answer that question, so each needs SELECT on it.
--
-- WHAT THEY HAD. `20260901102700_row_level_security` and
-- `20260901190000_platform_role_separation` granted both roles
-- SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, and Prisma had
-- created `_prisma_migrations` before either ran, so both could already read
-- it — and WRITE it. Nothing at runtime writes the history, and a runtime
-- identity that can insert a row there can make a release report ready over a
-- schema it does not have. SELECT is granted explicitly here (so the gate does
-- not depend on the side effect of an old blanket grant) and every write
-- privilege is taken away.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. Privileges only: no table, column or
-- row changes. No release reads or writes `_prisma_migrations` at runtime
-- before this one, and `prisma migrate deploy` writes it as
-- `brandspace_migrator`, the table's owner, which this does not touch.
--
-- IDEMPOTENT. GRANT and REVOKE of a privilege already in that state are
-- no-ops. Guarded on the table existing because several isolation suites
-- replay these files through psql, where Prisma's history table is never
-- created; under `prisma migrate deploy` it always exists.
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
BEGIN
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public."_prisma_migrations" TO brandspace_app, brandspace_platform';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER '
         || 'ON TABLE public."_prisma_migrations" FROM brandspace_app, brandspace_platform';

    IF NOT has_table_privilege('brandspace_app', 'public."_prisma_migrations"', 'SELECT')
       OR NOT has_table_privilege('brandspace_platform', 'public."_prisma_migrations"', 'SELECT')
       OR has_table_privilege('brandspace_app', 'public."_prisma_migrations"', 'INSERT, UPDATE, DELETE, TRUNCATE')
       OR has_table_privilege('brandspace_platform', 'public."_prisma_migrations"', 'INSERT, UPDATE, DELETE, TRUNCATE')
    THEN
      RAISE EXCEPTION 'the runtime roles must read _prisma_migrations and write nothing to it';
    END IF;
  END IF;
END $$;

COMMIT;
