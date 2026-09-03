-- ===========================================================================
-- Invitation redemption on the TENANT role.
--
-- THE DEFECT THIS FIXES. `peek()` and `accept()` are called by the customer
-- application, which connects as `brandspace_app` and has NO workspace context
-- at that moment: the holder of an invitation link is not a member yet, so
-- there is no workspace to bind. Every policy on `invitation` requires
-- `"workspaceId" = app.current_workspace_id()`, so the read returned nothing
-- and every invitation link was dead. The isolation suite did not catch it
-- because it exercised the service through the PLATFORM client, which is
-- governed by a different policy — a real coverage gap, now closed.
--
-- WHY NOT THE OBVIOUS FIXES:
--
--   * Relaxing `tenant_isolation` to allow a context-less read would let the
--     tenant role enumerate every invitation in the system — every pending
--     recipient address in every workspace.
--   * Handing the customer application the platform credential is forbidden
--     (F-07, and an ESLint rule plus a unit test refuse the import).
--   * `SECURITY DEFINER` cannot work here: the tables are under FORCE ROW
--     LEVEL SECURITY, so a function owned by the migrator is itself subject to
--     policy, and no policy names the migrator.
--
-- THE MECHANISM, identical in shape to the session scope added by
-- 20260902210000: a transaction-local GUC carries the SHA-256 hash of the
-- invitation token the caller already holds, and ONE SELECT-only policy
-- exposes exactly the row that token addresses. The widening is:
--
--   * read-only         — no INSERT, UPDATE or DELETE is granted by it;
--   * one row           — keyed on a 256-bit token the caller must present;
--   * pending only      — a spent, revoked or expired token reads nothing, so
--                         it cannot even confirm that the invitation existed;
--   * context-less only — it is inert once a workspace context is set, so it
--                         can never widen an ordinary tenant request.
--
-- Acceptance itself does NOT run under this scope. The service reads the
-- invitation's `workspaceId` through this policy, drops the token scope, and
-- performs every write inside the ordinary workspace context — so the
-- conditional status update, the membership upsert and the audit event are all
-- governed by the normal tenant policies, exactly like any other tenant write.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.current_invitation_token_hash()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.invitation_token_hash', true), '')
$$;

COMMENT ON FUNCTION app.current_invitation_token_hash() IS
  'The SHA-256 hash of the invitation token the current transaction presented. '
  'Transaction-local; never set on a pooled connection outside a transaction.';

CREATE POLICY invitation_by_token ON "invitation"
  FOR SELECT
  TO brandspace_app
  USING (
    app.current_workspace_id() IS NULL
    AND app.current_invitation_token_hash() IS NOT NULL
    AND "tokenHash" = app.current_invitation_token_hash()
    AND "status" = 'PENDING'
    AND "expiresAt" > now()
  );

-- The platform role reads invitations through `platform_access`; it needs no
-- token scope and must not gain one.
