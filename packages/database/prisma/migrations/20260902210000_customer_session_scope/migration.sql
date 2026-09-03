-- ===========================================================================
-- Phase 2B — the two reads a customer session needs BEFORE it has a workspace.
--
-- After authentication the application must answer two questions that precede
-- any workspace context:
--
--   1. "Which workspaces may this person act in?"  (membership + workspace)
--   2. "What does their plan entitle them to?"      (the catalogue)
--
-- Under RLS the tenant role sees nothing without a context, which is right for
-- customer data and wrong for these two. Both are solved WITHOUT SECURITY
-- DEFINER, because a definer function here would not work anyway: the tables
-- are under FORCE ROW LEVEL SECURITY, so even the owner is subject to policy,
-- and no policy names the migrator.
--
-- ---------------------------------------------------------------------------
-- 1. Session-scoped read of one's own memberships
-- ---------------------------------------------------------------------------
--
-- A transaction-local GUC carries the SESSION TOKEN HASH, and a policy grants
-- exactly the rows that session's user is an active member of. Three properties
-- make this narrow:
--
--   * It applies ONLY with a NULL workspace context. Inside a workspace the
--     ordinary tenant policy is the only one that can match, so this cannot be
--     used to widen a request that already has a tenant.
--   * The GUC is a session TOKEN HASH, not a user id. A caller must already
--     hold the token; guessing a user id buys nothing.
--   * The policy re-validates the session inline — not revoked, not expired,
--     not past its absolute lifetime — so a stale token selects no rows.
--
-- Expressed as a POLICY rather than as definer rights, so the widening is
-- visible in `pg_policies` and is evaluated by the same machinery as every
-- other rule.
--
-- WHY THE POLICIES DO NOT JOIN `user`. Checking the user's status here would
-- read `user`, whose own policy reads `membership`, whose policy would read
-- `user` again: PostgreSQL refuses that with "infinite recursion detected in
-- policy". The check therefore lives one layer up, where it already ran first:
-- `CustomerAuthService.resolve()` loads the session's user and returns null for
-- any non-ACTIVE or deleted account BEFORE these reads happen, and
-- `switchWorkspace()` resolves before it lists. Suspending a user also revokes
-- their sessions, which these policies DO check.

CREATE OR REPLACE FUNCTION app.current_session_token_hash()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.session_token_hash', true), '');
$$;

COMMENT ON FUNCTION app.current_session_token_hash() IS
  'The SHA-256 hash of the customer session token for this transaction, set by '
  'withCustomerSession(). Empty or unset means no session scope.';

-- Memberships belonging to the holder of the current session token.
CREATE POLICY session_membership ON "membership"
  FOR SELECT
  TO brandspace_app
  USING (
    app.current_workspace_id() IS NULL
    AND app.current_session_token_hash() IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM "customer_session" s
       WHERE s."tokenHash" = app.current_session_token_hash()
         AND s."userId" = "membership"."userId"
         AND s."revokedAt" IS NULL
         AND s."expiresAt" > now()
         AND s."absoluteExpiresAt" > now()
    )
  );

-- The workspaces those memberships point at, and nothing else.
CREATE POLICY session_workspace ON "workspace"
  FOR SELECT
  TO brandspace_app
  USING (
    app.current_workspace_id() IS NULL
    AND app.current_session_token_hash() IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM "membership" m
        JOIN "customer_session" s ON s."userId" = m."userId"
       WHERE m."workspaceId" = "workspace"."id"
         AND m."status" = 'ACTIVE'
         AND s."tokenHash" = app.current_session_token_hash()
         AND s."revokedAt" IS NULL
         AND s."expiresAt" > now()
         AND s."absoluteExpiresAt" > now()
    )
  );

-- ---------------------------------------------------------------------------
-- 2. The entitlement catalogue, projected for tenant reads
-- ---------------------------------------------------------------------------
--
-- `configuration_version` stays exactly as protected as it was: platform-owned,
-- every privilege revoked from the tenant role, no policy naming it. Instead
-- the Configuration Service PROJECTS the three customer-relevant domains here
-- when it activates one.
--
-- This table is a GLOBAL CATALOGUE in the sense the tenancy registry already
-- uses for `permission`: identical rows for every tenant, no customer data, no
-- secrets — feature keys, plan keys, limits and flag rules. The tenant role may
-- read it and may not write it.

CREATE TABLE "entitlement_catalogue_snapshot" (
    "domain" TEXT NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL,
    "payload" JSONB NOT NULL,
    "sourceVersionId" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "entitlement_catalogue_snapshot_pkey" PRIMARY KEY ("domain","environment")
);

-- Only the three domains a customer's entitlements depend on may ever be
-- projected. A CHECK rather than a convention: a future caller cannot copy
-- `integrations.payment` here by mistake.
ALTER TABLE "entitlement_catalogue_snapshot"
  ADD CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains"
  CHECK ("domain" IN ('entitlements', 'plans', 'feature-flags'));

GRANT SELECT ON "entitlement_catalogue_snapshot" TO brandspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement_catalogue_snapshot" TO brandspace_platform;
