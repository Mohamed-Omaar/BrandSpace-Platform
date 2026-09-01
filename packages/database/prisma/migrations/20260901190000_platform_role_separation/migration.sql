-- ===========================================================================
-- F-01 — Replace the application-settable platform GUC with a separate
--        database identity.
--
-- BEFORE: every policy read
--             workspace_id = app.current_workspace_id() OR app.is_platform_mode()
--         where `app.is_platform_mode()` read a session GUC. The application
--         role could set that GUC itself, so anyone able to execute arbitrary
--         SQL as brandspace_app could grant themselves cross-tenant visibility.
--         It was a control against developer error, not against an attacker.
--
-- AFTER:  policies are TARGETED AT A ROLE. Cross-tenant visibility is decided by
--         WHICH ROLE CONNECTED — i.e. by which credential was used — and there
--         is no session variable that changes it.
--
--           tenant_isolation  TO brandspace_app       workspace predicate only
--           platform_access   TO brandspace_platform  full access
--
--         brandspace_app cannot reach platform visibility by ANY SQL it can
--         execute: no policy names it, it is not a member of the platform role
--         so SET ROLE fails, and the GUC no longer exists.
--
-- Neither role has BYPASSRLS. The platform role's access comes from a policy
-- that is evaluated normally, not from a privilege that skips evaluation — so
-- WITH CHECK still applies and the behaviour stays visible in pg_policies.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Ensure the platform role exists.
--    scripts/sql/setup-database-roles.sql is the canonical definition; this
--    block only makes the migration self-sufficient on a fresh database.
--    It never sets a password — credentials come from the environment.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brandspace_platform') THEN
    CREATE ROLE brandspace_platform NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Drop the GUC-based policies.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON "workspace";
DROP POLICY IF EXISTS tenant_isolation ON "membership";
DROP POLICY IF EXISTS tenant_isolation ON "role";
DROP POLICY IF EXISTS tenant_isolation ON "audit_event";
DROP POLICY IF EXISTS tenant_isolation ON "support_mode_session";
DROP POLICY IF EXISTS tenant_isolation ON "user";

-- ---------------------------------------------------------------------------
-- 3. Remove the escape hatch itself.
--    Dropping the function guarantees no residual code path can re-enable
--    cross-tenant access through a session variable.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app.is_platform_mode();

-- ---------------------------------------------------------------------------
-- 4. Tenant policies — TO brandspace_app only.
--    A NULL workspace context matches nothing, so the default stays fail-closed.
-- ---------------------------------------------------------------------------
CREATE POLICY tenant_isolation ON "workspace"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "membership"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- workspaceId IS NULL denotes a SYSTEM role, readable by every workspace
-- because permissions must resolve at all. A tenant may only ever WRITE a role
-- scoped to its own workspace.
CREATE POLICY tenant_isolation ON "role"
  TO brandspace_app
  USING      ("workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- workspaceId IS NULL denotes a PLATFORM-only event. `NULL = <uuid>` is never
-- true, so platform events stay invisible to tenants with no special case.
CREATE POLICY tenant_isolation ON "audit_event"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "support_mode_session"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- User is a GLOBAL identity. Inside a workspace context only that workspace's
-- members are visible, which is what stops A enumerating B's members. With NO
-- context the row is readable because authentication must resolve a user by
-- email before any workspace is known (docs/DECISIONS.md F-02).
CREATE POLICY tenant_isolation ON "user"
  TO brandspace_app
  USING (
    app.current_workspace_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM "membership" m
       WHERE m."userId" = "user"."id"
         AND m."workspaceId" = app.current_workspace_id()
         AND m."status" <> 'REMOVED'
    )
  )
  WITH CHECK (app.current_workspace_id() IS NULL);

-- ---------------------------------------------------------------------------
-- 5. Platform policies — TO brandspace_platform only.
--    Full access, still evaluated as a policy rather than bypassing RLS.
-- ---------------------------------------------------------------------------
CREATE POLICY platform_access ON "workspace"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "membership"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "role"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "audit_event"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "support_mode_session"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "user"
  TO brandspace_platform USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. Privileges for the platform role.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO brandspace_platform;
GRANT USAGE ON SCHEMA app    TO brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO brandspace_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO brandspace_platform;

ALTER DEFAULT PRIVILEGES FOR ROLE brandspace_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brandspace_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE brandspace_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO brandspace_platform;

-- ---------------------------------------------------------------------------
-- 7. Audit immutability applies to the PLATFORM role too.
--    Platform operations write the audit trail; nothing may rewrite it.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "audit_event" FROM brandspace_platform;
REVOKE UPDATE, DELETE ON "audit_event" FROM brandspace_app;

-- ---------------------------------------------------------------------------
-- 8. Assert the separation holds.
--
--    brandspace_app must never be a member of brandspace_platform, or it could
--    SET ROLE into it and inherit platform_access.
--
--    This ASSERTS rather than REVOKEs on purpose: revoking a role membership
--    requires ADMIN option on that role, which the migrator deliberately does
--    not hold. Granting the migrator power over role membership would make it a
--    privilege-escalation path in its own right. Membership is owned by
--    scripts/sql/setup-database-roles.sql, run by a DBA; the migration's job is
--    to refuse to deploy if that separation is missing.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF pg_has_role('brandspace_app', 'brandspace_platform', 'MEMBER') THEN
    RAISE EXCEPTION
      'brandspace_app is a member of brandspace_platform; SET ROLE would grant cross-tenant access. '
      'Fix role membership with scripts/sql/setup-database-roles.sql before deploying.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('brandspace_app','brandspace_platform')
               AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'brandspace_app / brandspace_platform must not be superuser or BYPASSRLS.';
  END IF;
END
$$;
