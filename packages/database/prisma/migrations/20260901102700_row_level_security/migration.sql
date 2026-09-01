-- ===========================================================================
-- BrandSpace — Row-Level Security, privilege model, and audit immutability.
--
-- docs/SECURITY.md §2: isolation is enforced in two INDEPENDENT layers.
-- This migration is layer 2 (database). It must hold even if the application
-- layer is completely bypassed — that property is proven by the raw-SQL tests
-- in tests/isolation/rls-raw-sql.test.ts, which connect as the app role and
-- issue SQL directly, with no application code in the path.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Tenant context helpers
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;

-- Resolve the current workspace from the transaction-local GUC.
-- Returns NULL when unset. Because every tenant policy compares with `=`, a NULL
-- context matches NOTHING: the default is fail-closed, not fail-open.
CREATE OR REPLACE FUNCTION app.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;

-- Platform mode: the audited cross-tenant escape hatch (asPlatform()).
-- Set ONLY by packages/database/src/platform.ts, which requires a platform actor
-- and writes an AuditEvent. Transaction-local, so it can never leak across a
-- pooled connection.
CREATE OR REPLACE FUNCTION app.is_platform_mode()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.platform_mode', true), ''), 'off') = 'on'
$$;

COMMENT ON FUNCTION app.is_platform_mode() IS
  'Audited cross-tenant escape hatch. Enforced at the application layer by asPlatform(), '
  'which requires a platform actor and writes an AuditEvent. See docs/SECURITY.md §2.4.';

-- ---------------------------------------------------------------------------
-- 2. Structural invariant: Workspace.workspaceId always equals Workspace.id
--    so the tenant predicate is uniform across every tenant-owned table,
--    including the workspace table itself.
-- ---------------------------------------------------------------------------
ALTER TABLE "workspace"
  ADD CONSTRAINT workspace_tenant_key_matches_id CHECK ("workspaceId" = "id");

-- ---------------------------------------------------------------------------
-- 3. Enable + FORCE row level security on every tenant-owned table.
--
--    FORCE matters: without it the table OWNER bypasses RLS silently. With it,
--    even the migrator role is subject to policy, so the seed script must go
--    through the same audited platform path as production code.
-- ---------------------------------------------------------------------------
ALTER TABLE "workspace"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace"             FORCE  ROW LEVEL SECURITY;
ALTER TABLE "membership"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership"            FORCE  ROW LEVEL SECURITY;
ALTER TABLE "role"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role"                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "audit_event"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_event"           FORCE  ROW LEVEL SECURITY;
ALTER TABLE "support_mode_session"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_mode_session"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "user"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user"                  FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------

-- 4.1 Workspace — the boundary row itself.
CREATE POLICY tenant_isolation ON "workspace"
  USING      ("workspaceId" = app.current_workspace_id() OR app.is_platform_mode())
  WITH CHECK ("workspaceId" = app.current_workspace_id() OR app.is_platform_mode());

-- 4.2 Membership — strictly tenant-owned.
CREATE POLICY tenant_isolation ON "membership"
  USING      ("workspaceId" = app.current_workspace_id() OR app.is_platform_mode())
  WITH CHECK ("workspaceId" = app.current_workspace_id() OR app.is_platform_mode());

-- 4.3 Role — nullable tenant key.
--     workspaceId IS NULL  => system role, resolvable by every workspace
--                             (needed to resolve permissions at all).
--     workspaceId = <uuid> => a workspace's own custom role, private to it.
CREATE POLICY tenant_isolation ON "role"
  USING (
    "workspaceId" IS NULL
    OR "workspaceId" = app.current_workspace_id()
    OR app.is_platform_mode()
  )
  WITH CHECK (
    -- A tenant may only ever WRITE a role scoped to its own workspace.
    -- Creating or altering a system role is a platform operation.
    ("workspaceId" = app.current_workspace_id())
    OR app.is_platform_mode()
  );

-- 4.4 AuditEvent — nullable tenant key, opposite semantics to Role.
--     workspaceId IS NULL => a PLATFORM-only event. `NULL = <uuid>` is NULL,
--     never true, so platform events are invisible to tenants with no special case.
CREATE POLICY tenant_isolation ON "audit_event"
  USING      ("workspaceId" = app.current_workspace_id() OR app.is_platform_mode())
  WITH CHECK ("workspaceId" = app.current_workspace_id() OR app.is_platform_mode());

-- 4.5 SupportModeSession — visible to the workspace it targets, so a customer can
--     see that support accessed their data (D-28, docs/SECURITY.md §8).
CREATE POLICY tenant_isolation ON "support_mode_session"
  USING      ("workspaceId" = app.current_workspace_id() OR app.is_platform_mode())
  WITH CHECK ("workspaceId" = app.current_workspace_id() OR app.is_platform_mode());

-- 4.6 User — a GLOBAL identity, not tenant-owned, so it needs a different rule.
--
--     Inside a workspace context: only users who hold a membership in THAT
--     workspace are visible. This is what stops workspace A enumerating the
--     members of workspace B (AC-16.14).
--
--     Outside any workspace context: readable, because authentication must look a
--     user up by email BEFORE any workspace is known. This exception is deliberate
--     and narrow: the authentication path is the only code that runs with no
--     tenant context, and it is covered by tests asserting the in-context case.
CREATE POLICY tenant_isolation ON "user"
  USING (
    app.is_platform_mode()
    OR app.current_workspace_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM "membership" m
       WHERE m."userId" = "user"."id"
         AND m."workspaceId" = app.current_workspace_id()
         AND m."status" <> 'REMOVED'
    )
  )
  WITH CHECK (
    app.is_platform_mode()
    OR app.current_workspace_id() IS NULL
  );

-- ---------------------------------------------------------------------------
-- 5. Privilege model.
--
--    The application role owns NOTHING and cannot bypass RLS. It receives only
--    the DML it needs. Ownership stays with the migrator role, which never
--    serves a request.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO brandspace_app;
GRANT USAGE ON SCHEMA app    TO brandspace_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO brandspace_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO brandspace_app;

-- Future tables created by the migrator are granted to the app role automatically,
-- so a new table is never accidentally unreadable — or accidentally over-granted,
-- because RLS still governs row visibility.
ALTER DEFAULT PRIVILEGES FOR ROLE brandspace_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brandspace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE brandspace_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO brandspace_app;

-- ---------------------------------------------------------------------------
-- 6. Audit immutability — docs/SECURITY.md §7.
--    "The application role has SELECT/INSERT only on audit_event;
--     UPDATE/DELETE are revoked."
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "audit_event" FROM brandspace_app;

-- Belt and braces: a trigger blocks UPDATE/DELETE even for a role that somehow
-- holds the privilege (for example the table owner during a migration).
CREATE OR REPLACE FUNCTION app.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (%, attempted by %)', TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_event_is_append_only
  BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();
