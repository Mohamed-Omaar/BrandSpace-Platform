-- ===========================================================================
-- Phase 2B — let the authentication path write its outbox rows.
--
-- THE SAME DEFECT AS 20260902230000, in the outbox. A password-reset email has
-- NO workspace: the address is all that is known, and deliberately so — the
-- reset endpoint must answer identically whether or not an account exists, so
-- it cannot resolve a workspace without becoming an existence oracle. The
-- tenant policy's WITH CHECK is `"workspaceId" = app.current_workspace_id()`,
-- and `NULL = NULL` is NULL rather than true, so every such INSERT was refused.
-- The send is wrapped in a try/catch precisely so a mail failure cannot change
-- the uniform response — which meant the rows were being dropped SILENTLY, and
-- the reset flow looked like it worked while sending nothing.
--
-- THE FIX, and its limits. WITH CHECK now also permits a NULL-workspace row
-- when there is NO workspace context. The same three constraints as the audit
-- fix keep it narrow:
--
--   * USING is UNCHANGED. The tenant role still cannot READ a workspace-less
--     outbox row. This is a write-only widening, so it cannot be turned into a
--     way to enumerate reset requests for addresses in other tenants.
--   * It applies only with a NULL context. Inside a workspace, writing a
--     NULL-workspace row is still refused, so a tenant cannot detach a message
--     from their workspace to keep it out of their own Activity Log.
--   * A workspace-scoped message still requires the matching context, so the
--     invitation mail must be written inside the workspace it belongs to.
-- ===========================================================================

DROP POLICY IF EXISTS tenant_isolation ON "email_message";

CREATE POLICY tenant_isolation ON "email_message"
  TO brandspace_app
  -- Read: unchanged. A NULL workspace never equals a uuid.
  USING ("workspaceId" = app.current_workspace_id())
  -- Write: the workspace's own messages, plus authentication messages that
  -- precede any workspace.
  WITH CHECK (
    "workspaceId" = app.current_workspace_id()
    OR (app.current_workspace_id() IS NULL AND "workspaceId" IS NULL)
  );
