-- ---------------------------------------------------------------------------
-- THE TENANT ROLE MAY READ THE GLOBAL CATALOGUES AND MAY NOT WRITE THEM.
--
-- WHAT WENT WRONG, because the shape matters more than the fix.
--
-- `20260901102700_row_level_security` granted the tenant role full CRUD twice
-- over: once for the tables that existed then
--
--     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
--       TO brandspace_app;                                        -- line 151
--
-- and once, standing, for every table the migrator would create afterwards
--
--     ALTER DEFAULT PRIVILEGES FOR ROLE brandspace_migrator IN SCHEMA public
--       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brandspace_app;
--                                                              -- lines 157-158
--
-- Both are correct for tenant-owned tables, where row-level security is what
-- confines the role and the privilege is only the outer gate. Neither is
-- correct for a GLOBAL CATALOGUE: those three tables carry identical rows for
-- every workspace, they have no `workspaceId` to filter on, and so they carry
-- NO row-level security at all. For them the privilege is the only gate, and it
-- was wide open.
--
-- `20260902210000_customer_session_scope` even said the right thing in prose —
-- "The tenant role may read it and may not write it" — and then issued only
-- `GRANT SELECT`, which is additive. Nothing ever revoked the write.
--
-- This is the F-10 pattern a second time. There, a blanket grant left the
-- Platform Owner's password hash readable by the tenant role. Here it leaves
-- three platform-wide tables writable by it.
--
-- WHY IT WAS NOT CAUGHT. `scripts/isolation-gate.ts` checks the `tenant`,
-- `identity` and `platform` classifications. Models classified `global` receive
-- no checks at all, so classifying a model as a global catalogue is currently a
-- way to opt out of the gate entirely. Closing that is a separate change to the
-- gate; this migration closes the hole it hid.
--
-- WHAT EACH TABLE WOULD HAVE COST:
--
--   role_permission  — maps roles to permissions. Writable by the tenant role
--                      means: grant `client_viewer` every permission in the
--                      platform, for every workspace at once. The worst of the
--                      three by a distance.
--   permission       — the permission catalogue itself.
--   entitlement_catalogue_snapshot
--                    — plan limits, feature availability and flag rules, as
--                      projected to every tenant. Rewriting it changes what
--                      every workspace is entitled to, and leaves
--                      `configuration_version` still showing the old truth, so
--                      the change history would not record the tampering.
--
-- NOTHING IN THE APPLICATION LOSES A CAPABILITY. Every writer of these tables
-- runs on the platform identity: `ConfigurationService` projects the snapshot
-- (packages/config/src/service.ts), and `prisma/seed.ts` writes the permission
-- catalogue over `DATABASE_PLATFORM_URL`. The tenant role only ever reads them,
-- which is why this is a revoke and not a redesign.
--
-- `brandspace_platform` keeps full access, granted by
-- `20260901190000_platform_role_separation` line 132.
-- ---------------------------------------------------------------------------

BEGIN;

REVOKE INSERT, UPDATE, DELETE ON "permission" FROM brandspace_app;
REVOKE INSERT, UPDATE, DELETE ON "role_permission" FROM brandspace_app;
REVOKE INSERT, UPDATE, DELETE ON "entitlement_catalogue_snapshot" FROM brandspace_app;

-- SELECT is what the tenant role legitimately needs and is re-granted here
-- rather than assumed, so a restore into a fresh cluster lands in the intended
-- state whatever order the grants ran in.
GRANT SELECT ON "permission" TO brandspace_app;
GRANT SELECT ON "role_permission" TO brandspace_app;
GRANT SELECT ON "entitlement_catalogue_snapshot" TO brandspace_app;

-- ---------------------------------------------------------------------------
-- VERIFY THE RESULT RATHER THAN ASSUMING IT.
--
-- A migration that silently did nothing is the failure mode this whole file
-- exists to correct, so it asserts its own outcome and raises if the database
-- disagrees. The same style as `setup-database-roles.sql`, for the same reason.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  target TEXT;
  privilege TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['permission', 'role_permission', 'entitlement_catalogue_snapshot']
  LOOP
    FOREACH privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE']
    LOOP
      IF has_table_privilege('brandspace_app', format('public.%I', target), privilege) THEN
        RAISE EXCEPTION
          'brandspace_app still holds % on %, which is the privilege this migration exists to remove.',
          privilege, target;
      END IF;
    END LOOP;

    IF NOT has_table_privilege('brandspace_app', format('public.%I', target), 'SELECT') THEN
      RAISE EXCEPTION 'brandspace_app lost SELECT on %, which it legitimately needs.', target;
    END IF;

    IF NOT has_table_privilege('brandspace_platform', format('public.%I', target), 'INSERT') THEN
      RAISE EXCEPTION 'brandspace_platform cannot write %, so the platform writer is broken.', target;
    END IF;
  END LOOP;
END
$$;

COMMIT;
