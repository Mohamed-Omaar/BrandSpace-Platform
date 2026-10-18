-- Connected AI apps — the remote MCP server (D-566, approved by the owner as
-- written on 2026-10-18, audit §4).
--
-- A customer connects Claude, ChatGPT or any MCP client to their Brandspace
-- account. Brandspace is the OAuth 2.1 authorization server (public clients,
-- PKCE S256, refresh-token rotation) and the MCP resource server.
--
--   ai_app_client             — GLOBAL: registered apps (RFC 7591). No customer
--                               data and no secret; the tenant role may read it
--                               (the consent screen names the app) and never
--                               write it. Registration writes it through the
--                               platform role.
--   ai_app_connection         — TENANT: one person's grant to one app, in one
--                               workspace, on these brands (empty = all the
--                               member may see, including brands added later).
--   ai_app_authorization_code — TENANT: one-time codes, PKCE challenge, bound
--                               to the redirect and the resource.
--   ai_app_token              — TENANT: access and refresh tokens, SHA-256 hash
--                               only; a rotated refresh token points at its
--                               successor.
--   ai_app_rate_window        — TENANT: per-connection fixed-window counter.
--
-- A token or code is looked up BEFORE a workspace is known, by the hash the
-- caller already holds (GUC app.ai_app_token_hash, read-only policies), exactly
-- as customer sessions are. Every write then runs inside withWorkspace().
--
-- FORWARD-ONLY and additive: no existing table, row, policy or grant changes.
-- Expired codes and tokens, old rate windows and clients that never got a
-- connection 30 days after registration are purged by the maintenance sweep.

-- Brandspace remote MCP ("Connected AI apps"), owner decision 2026-10-18.
-- Forward-only and additive: new types, tables and one function; no existing table changes.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "AiAppConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "AiAppTokenKind"        AS ENUM ('ACCESS', 'REFRESH');

-- The hash of the bearer token or authorization code being looked up, set by
-- withAiAppToken() for one transaction. Empty or unset means no lookup.
CREATE OR REPLACE FUNCTION app.current_ai_app_token_hash()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.ai_app_token_hash', true), '');
$$;

-- 1. Registered AI apps (OAuth public clients, RFC 7591). Global: no customer data, no secret.
CREATE TABLE "ai_app_client" (
  "id"              UUID         NOT NULL,
  "clientId"        TEXT         NOT NULL,
  "clientName"      TEXT         NOT NULL,
  "redirectUris"    TEXT[]       NOT NULL,
  "softwareId"      TEXT,
  "softwareVersion" TEXT,
  "clientUri"       TEXT,
  "logoUri"         TEXT,
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disabledAt"      TIMESTAMPTZ(6),
  CONSTRAINT "ai_app_client_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_app_client_client_id_shape" CHECK ("clientId" ~ '^bsp_cli_[A-Za-z0-9_-]{32,64}$'),
  CONSTRAINT "ai_app_client_name_length"     CHECK (char_length("clientName") BETWEEN 1 AND 100),
  CONSTRAINT "ai_app_client_redirect_count"  CHECK (cardinality("redirectUris") BETWEEN 1 AND 10),
  CONSTRAINT "ai_app_client_software_shape"  CHECK (
    ("softwareId" IS NULL OR char_length("softwareId") <= 200) AND
    ("softwareVersion" IS NULL OR char_length("softwareVersion") <= 100) AND
    ("clientUri" IS NULL OR ("clientUri" ~ '^https://' AND char_length("clientUri") <= 500)) AND
    ("logoUri" IS NULL OR ("logoUri" ~ '^https://' AND char_length("logoUri") <= 500)))
);
CREATE UNIQUE INDEX "ai_app_client_clientId_key" ON "ai_app_client" ("clientId");

-- 2. A person's grant: this app may act as this member, in this workspace, on these brands.
CREATE TABLE "ai_app_connection" (
  "id"              UUID           NOT NULL,
  "workspaceId"     UUID           NOT NULL,
  "userId"          UUID           NOT NULL,
  "clientId"        UUID           NOT NULL,
  "brandIds"        UUID[]         NOT NULL DEFAULT '{}',   -- empty = every brand the member may see
  "scopes"          TEXT[]         NOT NULL,
  "status"          "AiAppConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"      TIMESTAMPTZ(6),
  "revokedAt"       TIMESTAMPTZ(6),
  "revokedByUserId" UUID,
  "revokedReason"   TEXT,
  CONSTRAINT "ai_app_connection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_app_connection_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_app_connection_user_fkey"      FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_app_connection_client_fkey"    FOREIGN KEY ("clientId") REFERENCES "ai_app_client"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_app_connection_revoker_fkey"   FOREIGN KEY ("revokedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_app_connection_scopes_known"   CHECK ("scopes" <@ ARRAY['brandspace.read','brandspace.write','offline_access']::TEXT[] AND cardinality("scopes") >= 1),
  CONSTRAINT "ai_app_connection_brand_count"    CHECK (cardinality("brandIds") <= 100),
  CONSTRAINT "ai_app_connection_revoked_shape"  CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)),
  CONSTRAINT "ai_app_connection_reason_shape"   CHECK ("revokedReason" IS NULL OR "revokedReason" ~ '^[a-z0-9_.]{1,60}$')
);
CREATE UNIQUE INDEX "ai_app_connection_workspaceId_id_key" ON "ai_app_connection" ("workspaceId", "id");
CREATE INDEX "ai_app_connection_workspaceId_status_idx"    ON "ai_app_connection" ("workspaceId", "status");
CREATE INDEX "ai_app_connection_userId_idx"                ON "ai_app_connection" ("userId");
CREATE INDEX "ai_app_connection_clientId_idx"              ON "ai_app_connection" ("clientId");

-- 3. One-time authorization codes (RFC 6749 §4.1), PKCE S256, bound to the resource.
CREATE TABLE "ai_app_authorization_code" (
  "id"            UUID           NOT NULL,
  "workspaceId"   UUID           NOT NULL,
  "connectionId"  UUID           NOT NULL,
  "codeHash"      TEXT           NOT NULL,
  "codeChallenge" TEXT           NOT NULL,
  "redirectUri"   TEXT           NOT NULL,
  "resource"      TEXT           NOT NULL,
  "scopes"        TEXT[]         NOT NULL,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"     TIMESTAMPTZ(6) NOT NULL,
  "consumedAt"    TIMESTAMPTZ(6),
  CONSTRAINT "ai_app_authorization_code_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_app_authorization_code_connection_fkey" FOREIGN KEY ("workspaceId", "connectionId")
    REFERENCES "ai_app_connection"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_app_authorization_code_hash_shape"      CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_app_authorization_code_challenge_shape" CHECK ("codeChallenge" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "ai_app_authorization_code_redirect_shape"  CHECK ("redirectUri" ~ '^(https://|http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?/)' AND char_length("redirectUri") <= 500),
  CONSTRAINT "ai_app_authorization_code_resource_shape"  CHECK ("resource" ~ '^https?://' AND char_length("resource") <= 500),
  CONSTRAINT "ai_app_authorization_code_scopes_known"    CHECK ("scopes" <@ ARRAY['brandspace.read','brandspace.write','offline_access']::TEXT[]),
  CONSTRAINT "ai_app_authorization_code_lifetime"        CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '10 minutes')
);
CREATE UNIQUE INDEX "ai_app_authorization_code_codeHash_key" ON "ai_app_authorization_code" ("codeHash");
CREATE INDEX "ai_app_authorization_code_expiresAt_idx"       ON "ai_app_authorization_code" ("expiresAt");

-- 4. Access and refresh tokens. Only the SHA-256 hash is stored; a rotated refresh token points at its successor.
CREATE TABLE "ai_app_token" (
  "id"           UUID           NOT NULL,
  "workspaceId"  UUID           NOT NULL,
  "connectionId" UUID           NOT NULL,
  "kind"         "AiAppTokenKind" NOT NULL,
  "tokenHash"    TEXT           NOT NULL,
  "resource"     TEXT           NOT NULL,
  "scopes"       TEXT[]         NOT NULL,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"    TIMESTAMPTZ(6) NOT NULL,
  "revokedAt"    TIMESTAMPTZ(6),
  "replacedById" UUID,
  CONSTRAINT "ai_app_token_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_app_token_connection_fkey" FOREIGN KEY ("workspaceId", "connectionId")
    REFERENCES "ai_app_connection"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_app_token_replaced_fkey"   FOREIGN KEY ("replacedById") REFERENCES "ai_app_token"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ai_app_token_hash_shape"      CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_app_token_resource_shape"  CHECK ("resource" ~ '^https?://' AND char_length("resource") <= 500),
  CONSTRAINT "ai_app_token_scopes_known"    CHECK ("scopes" <@ ARRAY['brandspace.read','brandspace.write','offline_access']::TEXT[]),
  CONSTRAINT "ai_app_token_replaced_kind"   CHECK ("replacedById" IS NULL OR "kind" = 'REFRESH'),
  CONSTRAINT "ai_app_token_lifetime"        CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '90 days')
);
CREATE UNIQUE INDEX "ai_app_token_tokenHash_key"       ON "ai_app_token" ("tokenHash");
CREATE INDEX "ai_app_token_connectionId_kind_idx"      ON "ai_app_token" ("connectionId", "kind");
CREATE INDEX "ai_app_token_expiresAt_idx"              ON "ai_app_token" ("expiresAt");

-- 5. Per-connection rate limit: fixed windows, counted atomically (same design as auth_rate_limit).
CREATE TABLE "ai_app_rate_window" (
  "workspaceId"  UUID           NOT NULL,
  "connectionId" UUID           NOT NULL,
  "windowStart"  TIMESTAMPTZ(6) NOT NULL,
  "count"        INTEGER        NOT NULL DEFAULT 0,
  CONSTRAINT "ai_app_rate_window_pkey" PRIMARY KEY ("connectionId", "windowStart"),
  CONSTRAINT "ai_app_rate_window_connection_fkey" FOREIGN KEY ("workspaceId", "connectionId")
    REFERENCES "ai_app_connection"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_app_rate_window_count_range" CHECK ("count" BETWEEN 0 AND 1000000)
);
CREATE INDEX "ai_app_rate_window_windowStart_idx" ON "ai_app_rate_window" ("windowStart");

-- Row-level security -------------------------------------------------------
ALTER TABLE "ai_app_client"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_app_client"             FORCE  ROW LEVEL SECURITY;
ALTER TABLE "ai_app_connection"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_app_connection"         FORCE  ROW LEVEL SECURITY;
ALTER TABLE "ai_app_authorization_code" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_app_authorization_code" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "ai_app_token"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_app_token"              FORCE  ROW LEVEL SECURITY;
ALTER TABLE "ai_app_rate_window"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_app_rate_window"        FORCE  ROW LEVEL SECURITY;

-- The client registry: read by everyone (the consent screen shows the app's name), written only by the platform role.
CREATE POLICY catalogue_read  ON "ai_app_client" FOR SELECT TO brandspace_app USING (true);
CREATE POLICY platform_access ON "ai_app_client" TO brandspace_platform USING (true) WITH CHECK (true);
REVOKE ALL ON "ai_app_client" FROM brandspace_app;
GRANT SELECT ON "ai_app_client" TO brandspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_app_client" TO brandspace_platform;

-- Tenant tables: the workspace only.
CREATE POLICY tenant_isolation ON "ai_app_connection" TO brandspace_app
  USING ("workspaceId" = app.current_workspace_id()) WITH CHECK ("workspaceId" = app.current_workspace_id());
CREATE POLICY tenant_isolation ON "ai_app_authorization_code" TO brandspace_app
  USING ("workspaceId" = app.current_workspace_id()) WITH CHECK ("workspaceId" = app.current_workspace_id());
CREATE POLICY tenant_isolation ON "ai_app_token" TO brandspace_app
  USING ("workspaceId" = app.current_workspace_id()) WITH CHECK ("workspaceId" = app.current_workspace_id());
CREATE POLICY tenant_isolation ON "ai_app_rate_window" TO brandspace_app
  USING ("workspaceId" = app.current_workspace_id()) WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Lookup by the hash the caller already holds, outside any workspace, read-only (the customer_session pattern).
CREATE POLICY token_lookup ON "ai_app_token" FOR SELECT TO brandspace_app
  USING (app.current_workspace_id() IS NULL
         AND app.current_ai_app_token_hash() IS NOT NULL
         AND "tokenHash" = app.current_ai_app_token_hash());
CREATE POLICY code_lookup ON "ai_app_authorization_code" FOR SELECT TO brandspace_app
  USING (app.current_workspace_id() IS NULL
         AND app.current_ai_app_token_hash() IS NOT NULL
         AND "codeHash" = app.current_ai_app_token_hash());

CREATE POLICY platform_access ON "ai_app_connection"         TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "ai_app_authorization_code" TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "ai_app_token"              TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "ai_app_rate_window"        TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_app_connection", "ai_app_authorization_code", "ai_app_token", "ai_app_rate_window"
  TO brandspace_app, brandspace_platform;

-- Proof: every table forces RLS, and the tenant role cannot write the client registry.
DO $$ DECLARE bad TEXT; BEGIN
  SELECT string_agg(name, ', ') INTO bad
    FROM unnest(ARRAY['ai_app_client','ai_app_connection','ai_app_authorization_code','ai_app_token','ai_app_rate_window']) AS name
   WHERE NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = name AND relnamespace = 'public'::regnamespace
                       AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ai apps: RLS not forced on %', bad; END IF;
  IF has_table_privilege('brandspace_app', 'public.ai_app_client', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'ai apps: the tenant role may write ai_app_client';
  END IF;
END $$;

COMMIT;
