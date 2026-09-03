-- ===========================================================================
-- Phase 2B — let the authentication path write its audit events.
--
-- THE PROBLEM. docs/SECURITY.md §7 requires failed logins, lockouts and
-- rate-limit failures to be audited. Those happen BEFORE any workspace is
-- known, so they are platform-scope events with `workspaceId = NULL`. The
-- tenant policy's WITH CHECK is `"workspaceId" = app.current_workspace_id()`,
-- and `NULL = NULL` is NULL, not true — so every such INSERT was refused. The
-- writes are wrapped in a try/catch so an audit failure never changes an
-- authentication result, which meant the events were being dropped SILENTLY.
--
-- THE FIX, and its limits. WITH CHECK now also permits a NULL-workspace event
-- when there is NO workspace context — that is, only from the authentication
-- path. Three things keep this narrow:
--
--   * USING is UNCHANGED. The tenant role still cannot READ platform-scope
--     events. This is a write-only widening.
--   * It applies only with a NULL context. Inside a workspace, an attempt to
--     write a NULL-workspace event is still refused, so a tenant cannot hide an
--     action by detaching it from their workspace.
--   * `audit_event` already has UPDATE and DELETE revoked from both roles, with
--     a trigger behind that, so nothing written here can be altered later.
-- ===========================================================================

DROP POLICY IF EXISTS tenant_isolation ON "audit_event";

CREATE POLICY tenant_isolation ON "audit_event"
  TO brandspace_app
  -- Read: unchanged. A NULL workspace never equals a uuid, so platform-scope
  -- events remain invisible to every tenant.
  USING ("workspaceId" = app.current_workspace_id())
  -- Write: the workspace's own events, plus authentication events that precede
  -- any workspace.
  WITH CHECK (
    "workspaceId" = app.current_workspace_id()
    OR (app.current_workspace_id() IS NULL AND "workspaceId" IS NULL)
  );
