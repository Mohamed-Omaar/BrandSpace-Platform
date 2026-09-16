-- ---------------------------------------------------------------------------
-- Phase 6 — Social Publishing (docs/SOCIAL-INTEGRATIONS.md, docs/DATABASE.md
-- §17, docs/ROADMAP.md Phase 6).
--
-- FIVE TENANT-OWNED TABLES, ONE ENUM EXTENSION, AND NOTHING ELSE.
--
-- WHY `social_credential` IS NOT A COLUMN ON `social_connection`. Every screen,
-- every list and every log line reads a connection; exactly one code path reads
-- a token. Put them in one table and `SELECT *` — which is what an ORM emits by
-- default — carries a customer's access token through the application on every
-- render. The split is the difference between "we are careful" and "it cannot
-- happen".
--
-- EVERY FOREIGN KEY TO A TENANT-OWNED PARENT IS COMPOSITE (D-112). There are
-- nine of them here. A plain key would resolve another workspace's row —
-- PostgreSQL evaluates referential integrity as the table OWNER with RLS
-- bypassed — and the difference between "inserted" and "violates foreign key"
-- would answer "does that id exist?" across the tenant boundary.
--
-- ONE EXPLICIT TRANSACTION (D-113). Prisma does not wrap a migration file in a
-- transaction, and this one extends an enum that later statements depend on, so
-- a partial application would leave a type with values no table uses and a
-- trigger guarding a table that does not exist. It does NOT lift FORCE RLS
-- anywhere: nothing here reads an existing tenant row.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Enums.
--
-- `PublishFailureClass` is the taxonomy from docs/SOCIAL-INTEGRATIONS.md §2.1
-- plus the three classes that come from OUR pre-flight rather than a provider.
-- It is STORED rather than re-derived from a message, because retry behaviour,
-- customer wording and the re-auth prompt all branch on it, and a message
-- string is not a contract.
-- ---------------------------------------------------------------------------

CREATE TYPE "SocialProvider" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'LINKEDIN', 'X');

CREATE TYPE "SocialConnectionStatus" AS ENUM (
  'PENDING', 'ACTIVE', 'NEEDS_REAUTH', 'REVOKED', 'DISABLED'
);

CREATE TYPE "PublishJobStatus" AS ENUM (
  'PENDING', 'QUEUED', 'PUBLISHING', 'VERIFICATION_PENDING', 'PUBLISHED', 'FAILED', 'CANCELLED'
);

CREATE TYPE "PublishFailureClass" AS ENUM (
  'AUTH_EXPIRED', 'AUTH_REVOKED', 'INSUFFICIENT_SCOPE', 'RATE_LIMITED',
  'CONTENT_REJECTED', 'MEDIA_INVALID', 'DUPLICATE_CONTENT', 'TARGET_UNAVAILABLE',
  'PLATFORM_UNAVAILABLE', 'TIMEOUT',
  'APPROVAL_REVOKED', 'NOT_CONNECTED', 'UNSUPPORTED', 'UNKNOWN'
);

CREATE TYPE "PublishAttemptOutcome" AS ENUM (
  'SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'INDETERMINATE'
);

-- ---------------------------------------------------------------------------
-- 2. The calendar slot gains the publishing half of its lifecycle.
--
-- Phase 5B-2 deliberately stopped at PLANNED / SCHEDULED / CANCELLED, on the
-- grounds that "a state no code can enter is a state whose meaning nobody has
-- settled". This phase settles them, so they arrive now — matched one-to-one
-- with the `ContentStatus` values that already exist, so the slot and the item
-- can never describe the same situation differently.
--
-- ADDING A VALUE IS NOT REMOVING ONE. Every existing row keeps its status and
-- every existing query keeps its meaning.
-- ---------------------------------------------------------------------------

ALTER TYPE "CalendarSlotStatus" ADD VALUE IF NOT EXISTS 'PUBLISHING';
ALTER TYPE "CalendarSlotStatus" ADD VALUE IF NOT EXISTS 'PUBLISHED';
ALTER TYPE "CalendarSlotStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_PUBLISHED';
ALTER TYPE "CalendarSlotStatus" ADD VALUE IF NOT EXISTS 'FAILED';

-- ---------------------------------------------------------------------------
-- 3. Parent-side composite keys the new children point at (D-112).
--
-- `content_item` and `brand` already carry theirs. `content_variant` and
-- `calendar_slot` did not, because until now nothing referenced them by a
-- workspace-scoped pair. Adding the UNIQUE is what makes the child keys below
-- provable rather than conventional.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "content_variant_workspaceId_id_key"
  ON "content_variant" ("workspaceId", "id");
CREATE UNIQUE INDEX "calendar_slot_workspaceId_id_key"
  ON "calendar_slot" ("workspaceId", "id");

-- ---------------------------------------------------------------------------
-- 4. `social_connection` — the customer's authorization to post to one account.
--
-- `brandId` IS NOT NULL, and that is a departure from the Asset Library's
-- nullable brand (D-138). A null brand there means "belongs to the workspace",
-- which is right for a shared logo pack and wrong for a publishing credential:
-- BrandScope has to be expressible as a query predicate (D-132/D-134), and
-- "visible to every brand" is exactly the hole a brand-restricted member would
-- publish through.
-- ---------------------------------------------------------------------------

CREATE TABLE "social_connection" (
    "id"                      UUID NOT NULL,
    "workspaceId"             UUID NOT NULL,
    "brandId"                 UUID NOT NULL,

    "provider"                "SocialProvider" NOT NULL,

    "externalAccountId"       TEXT NOT NULL,
    "displayName"             TEXT NOT NULL,
    "avatarUrl"               TEXT,
    "targetKind"              TEXT NOT NULL,

    "status"                  "SocialConnectionStatus" NOT NULL DEFAULT 'PENDING',

    -- The scopes the provider GRANTED, not the ones we asked for.
    "grantedScopes"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    "connectedByUserId"       UUID,
    "connectedAt"             TIMESTAMPTZ(6),

    "tokenExpiresAt"          TIMESTAMPTZ(6),
    "lastRefreshedAt"         TIMESTAMPTZ(6),

    "lastCheckedAt"           TIMESTAMPTZ(6),
    "lastSyncedAt"            TIMESTAMPTZ(6),
    "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureClass"        "PublishFailureClass",

    "revokedAt"               TIMESTAMPTZ(6),
    "disconnectedAt"          TIMESTAMPTZ(6),

    "createdAt"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"               TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "social_connection_pkey" PRIMARY KEY ("id")
);

-- A revoked or disconnected connection carries its timestamp, and a live one
-- does not. Without this the two facts can disagree and every reader has to
-- decide which it trusts.
ALTER TABLE "social_connection"
  ADD CONSTRAINT "social_connection_revoked_consistently"
  CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL));

-- ONLY AN ACTIVE CONNECTION MAY CLAIM TO HAVE BEEN CONNECTED BY SOMEBODY.
-- A PENDING row is a flow in progress and has no author yet.
ALTER TABLE "social_connection"
  ADD CONSTRAINT "social_connection_pending_is_unconnected"
  CHECK ("status" <> 'PENDING' OR "connectedAt" IS NULL);

CREATE UNIQUE INDEX "social_connection_workspaceId_id_key"
  ON "social_connection" ("workspaceId", "id");

-- ONE LIVE CONNECTION PER (BRAND, PROVIDER, EXTERNAL ACCOUNT).
--
-- PARTIAL, on the statuses that can still act. A revoked connection must not
-- block reconnecting the same account — which is the single most common thing a
-- customer does after a token expires — and a full unique index would make
-- reconnection impossible for ever. Same shape as D-100 and
-- `calendar_slot_one_live_per_item`.
CREATE UNIQUE INDEX "social_connection_one_live_per_account"
  ON "social_connection" ("workspaceId", "brandId", "provider", "externalAccountId")
  WHERE "status" IN ('PENDING', 'ACTIVE', 'NEEDS_REAUTH');

CREATE INDEX "social_connection_workspaceId_brandId_status_idx"
  ON "social_connection" ("workspaceId", "brandId", "status");
CREATE INDEX "social_connection_workspaceId_provider_status_idx"
  ON "social_connection" ("workspaceId", "provider", "status");
CREATE INDEX "social_connection_status_tokenExpiresAt_idx"
  ON "social_connection" ("status", "tokenExpiresAt");

ALTER TABLE "social_connection"
  ADD CONSTRAINT "social_connection_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "social_connection"
  ADD CONSTRAINT "social_connection_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. `social_credential` — the encrypted OAuth material.
--
-- VERSIONED AND RETIRED RATHER THAN OVERWRITTEN. A refresh writes a NEW row and
-- retires the previous one, so a rotation that half-fails leaves the old token
-- usable instead of leaving the connection holding nothing. The live credential
-- is the highest version with `retiredAt IS NULL`.
--
-- THE COLUMNS ARE THE SAME ENVELOPE `secret_version` USES, in a DIFFERENT KEY
-- DOMAIN (D-136): the publish worker holds the social KEK and must not be able
-- to unwrap a platform provider credential with it.
-- ---------------------------------------------------------------------------

CREATE TABLE "social_credential" (
    "id"                   UUID NOT NULL,
    "workspaceId"          UUID NOT NULL,
    "socialConnectionId"   UUID NOT NULL,

    "version"              INTEGER NOT NULL,

    "ciphertext"           TEXT NOT NULL,
    "iv"                   TEXT NOT NULL,
    "authTag"              TEXT NOT NULL,
    "wrappedDataKey"       TEXT NOT NULL,
    "keyProvider"          TEXT NOT NULL,
    "keyId"                TEXT NOT NULL,
    "algorithm"            TEXT NOT NULL DEFAULT 'AES-256-GCM',
    "encryptionContext"    TEXT NOT NULL,

    "maskedHint"           TEXT NOT NULL,
    "fingerprint"          TEXT NOT NULL,

    "accessTokenExpiresAt" TIMESTAMPTZ(6),
    "hasRefreshToken"      BOOLEAN NOT NULL DEFAULT false,

    "retiredAt"            TIMESTAMPTZ(6),
    "createdAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "social_credential_pkey" PRIMARY KEY ("id")
);

-- THE MASK IS A MASK, CHECKED BY THE DATABASE. A future call site that passed
-- the token itself into `maskedHint` would be storing a credential in a column
-- every audit view reads. Six characters is more than `…abcd` and less than any
-- token these providers issue.
ALTER TABLE "social_credential"
  ADD CONSTRAINT "social_credential_hint_is_masked"
  CHECK (length("maskedHint") <= 8);

ALTER TABLE "social_credential"
  ADD CONSTRAINT "social_credential_version_positive"
  CHECK ("version" >= 1);

CREATE UNIQUE INDEX "social_credential_workspaceId_socialConnectionId_version_key"
  ON "social_credential" ("workspaceId", "socialConnectionId", "version");

-- AT MOST ONE LIVE CREDENTIAL PER CONNECTION. Two would mean the refresh path
-- and the publish path could disagree about which token is current.
CREATE UNIQUE INDEX "social_credential_one_live_per_connection"
  ON "social_credential" ("workspaceId", "socialConnectionId")
  WHERE "retiredAt" IS NULL;

CREATE INDEX "social_credential_workspaceId_socialConnectionId_retiredAt_idx"
  ON "social_credential" ("workspaceId", "socialConnectionId", "retiredAt");

ALTER TABLE "social_credential"
  ADD CONSTRAINT "social_credential_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "social_credential"
  ADD CONSTRAINT "social_credential_connection_fkey"
  FOREIGN KEY ("workspaceId", "socialConnectionId")
  REFERENCES "social_connection"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 6. `social_oauth_state` — one authorization in flight.
--
-- THE STATE TOKEN IS STORED HASHED AND NEVER IN THE CLEAR. It is the CSRF
-- defence: whoever can present it can complete a connection. Storing the hash
-- means a database read — a backup, a support query, a compromised replica —
-- cannot be replayed as a callback.
--
-- THE PKCE VERIFIER IS STORED ENCRYPTED for the same reason, and it is a real
-- secret for the lifetime of the flow: an attacker holding the code AND the
-- verifier can complete the exchange without us.
--
-- `stateHash` IS UNIQUE PLATFORM-WIDE rather than per workspace. A per-tenant
-- unique would let the same state exist twice, and the callback arrives BEFORE
-- any workspace context has been established — the state is what establishes
-- it. A global unique is what makes "this state has already been used"
-- answerable at all.
-- ---------------------------------------------------------------------------

CREATE TABLE "social_oauth_state" (
    "id"                        UUID NOT NULL,
    "workspaceId"               UUID NOT NULL,
    "brandId"                   UUID NOT NULL,

    "provider"                  "SocialProvider" NOT NULL,

    "stateHash"                 TEXT NOT NULL,

    "verifierCiphertext"        TEXT NOT NULL,
    "verifierIv"                TEXT NOT NULL,
    "verifierAuthTag"           TEXT NOT NULL,
    "verifierWrappedDataKey"    TEXT NOT NULL,
    "verifierKeyProvider"       TEXT NOT NULL,
    "verifierKeyId"             TEXT NOT NULL,
    "verifierEncryptionContext" TEXT NOT NULL,

    "redirectUri"               TEXT NOT NULL,
    "requestedScopes"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    "startedByUserId"           UUID NOT NULL,
    "expiresAt"                 TIMESTAMPTZ(6) NOT NULL,
    "consumedAt"                TIMESTAMPTZ(6),
    "createdAt"                 TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "social_oauth_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "social_oauth_state_stateHash_key"
  ON "social_oauth_state" ("stateHash");
CREATE INDEX "social_oauth_state_workspaceId_expiresAt_idx"
  ON "social_oauth_state" ("workspaceId", "expiresAt");
CREATE INDEX "social_oauth_state_expiresAt_idx"
  ON "social_oauth_state" ("expiresAt");

ALTER TABLE "social_oauth_state"
  ADD CONSTRAINT "social_oauth_state_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "social_oauth_state"
  ADD CONSTRAINT "social_oauth_state_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 7. `publish_job` — one variant, one connection, one slot.
--
-- THE UNIT IS THE TRIPLE, NOT THE SLOT. A slot planned for two platforms is two
-- jobs, so one platform rejecting a caption does not fail the other and a retry
-- retries only what failed.
--
-- `idempotencyKey` IS UNIQUE PER WORKSPACE, and it is what makes a duplicate
-- post impossible rather than unlikely. The sweeper racing the producer, a
-- retry after a lost acknowledgement, two workers waking at once — all of them
-- find the existing row.
--
-- `onDelete: RESTRICT` ON THE CONNECTION, deliberately, where every other key
-- here cascades. A published post is a fact about the outside world; deleting
-- the connection must not silently erase the record of what was sent through
-- it. Disconnecting sets a status, it does not delete the row.
-- ---------------------------------------------------------------------------

CREATE TABLE "publish_job" (
    "id"                 UUID NOT NULL,
    "workspaceId"        UUID NOT NULL,
    "brandId"            UUID NOT NULL,

    "calendarSlotId"     UUID NOT NULL,
    "contentItemId"      UUID NOT NULL,
    "contentVariantId"   UUID NOT NULL,
    "socialConnectionId" UUID NOT NULL,

    "provider"           "SocialProvider" NOT NULL,
    "status"             "PublishJobStatus" NOT NULL DEFAULT 'PENDING',

    "idempotencyKey"     TEXT NOT NULL,

    "scheduledAtUtc"     TIMESTAMPTZ(6) NOT NULL,

    "attemptCount"       INTEGER NOT NULL DEFAULT 0,
    "maxAttempts"        INTEGER NOT NULL,
    "nextAttemptAt"      TIMESTAMPTZ(6),

    "claimedAt"          TIMESTAMPTZ(6),
    "startedAt"          TIMESTAMPTZ(6),
    "completedAt"        TIMESTAMPTZ(6),
    "cancelledAt"        TIMESTAMPTZ(6),

    "failureClass"       "PublishFailureClass",
    "failureCode"        TEXT,

    "externalPostId"     TEXT,
    "externalPostUrl"    TEXT,
    "publishedAt"        TIMESTAMPTZ(6),

    "createdByUserId"    UUID,
    "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"          TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "publish_job_pkey" PRIMARY KEY ("id")
);

-- A PUBLISHED JOB HAS A POST, AND A JOB WITH A POST IS PUBLISHED.
-- This is the invariant the whole duplicate-prevention design rests on: if a
-- job can be PUBLISHED with no external id, then "did this already go out?"
-- has no answer, and the only safe behaviour left is to never retry anything.
ALTER TABLE "publish_job"
  ADD CONSTRAINT "publish_job_published_has_post"
  CHECK (("status" = 'PUBLISHED') = ("externalPostId" IS NOT NULL AND "publishedAt" IS NOT NULL));

-- A FAILED JOB SAYS WHY. A failure with no class cannot be retried correctly,
-- cannot be explained to the customer and cannot be counted.
ALTER TABLE "publish_job"
  ADD CONSTRAINT "publish_job_failed_has_class"
  CHECK ("status" <> 'FAILED' OR "failureClass" IS NOT NULL);

ALTER TABLE "publish_job"
  ADD CONSTRAINT "publish_job_cancelled_consistently"
  CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));

ALTER TABLE "publish_job"
  ADD CONSTRAINT "publish_job_attempts_bounded"
  CHECK ("attemptCount" >= 0 AND "maxAttempts" >= 1 AND "attemptCount" <= "maxAttempts");

CREATE UNIQUE INDEX "publish_job_workspaceId_id_key"
  ON "publish_job" ("workspaceId", "id");
CREATE UNIQUE INDEX "publish_job_workspaceId_idempotencyKey_key"
  ON "publish_job" ("workspaceId", "idempotencyKey");

CREATE INDEX "publish_job_workspaceId_brandId_status_idx"
  ON "publish_job" ("workspaceId", "brandId", "status");
CREATE INDEX "publish_job_workspaceId_calendarSlotId_idx"
  ON "publish_job" ("workspaceId", "calendarSlotId");
CREATE INDEX "publish_job_workspaceId_contentItemId_idx"
  ON "publish_job" ("workspaceId", "contentItemId");
CREATE INDEX "publish_job_status_nextAttemptAt_idx"
  ON "publish_job" ("status", "nextAttemptAt");
CREATE INDEX "publish_job_status_scheduledAtUtc_idx"
  ON "publish_job" ("status", "scheduledAtUtc");

ALTER TABLE "publish_job"
  ADD CONSTRAINT "publish_job_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publish_job"
  ADD CONSTRAINT "publish_job_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publish_job"
  ADD CONSTRAINT "publish_job_slot_fkey"
  FOREIGN KEY ("workspaceId", "calendarSlotId") REFERENCES "calendar_slot"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "publish_job"
  ADD CONSTRAINT "publish_job_item_fkey"
  FOREIGN KEY ("workspaceId", "contentItemId") REFERENCES "content_item"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "publish_job"
  ADD CONSTRAINT "publish_job_variant_fkey"
  FOREIGN KEY ("workspaceId", "contentVariantId") REFERENCES "content_variant"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "publish_job"
  ADD CONSTRAINT "publish_job_connection_fkey"
  FOREIGN KEY ("workspaceId", "socialConnectionId")
  REFERENCES "social_connection"("workspaceId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 8. `publish_attempt` — the evidence trail, append-only.
--
-- This is what support reads and what a platform dispute rests on. A record
-- that can be edited afterwards is not evidence, so the trigger below refuses
-- UPDATE and DELETE to EVERY role including the table owner — the same
-- treatment `credit_transaction` and `ai_usage_ledger` already get.
--
-- `safeSummary` IS BOUNDED BY A CHECK. The raw provider body routinely echoes
-- the caption that was rejected, and a column with no ceiling is where a future
-- call site drops it.
-- ---------------------------------------------------------------------------

CREATE TABLE "publish_attempt" (
    "id"                 UUID NOT NULL,
    "workspaceId"        UUID NOT NULL,
    "publishJobId"       UUID NOT NULL,

    "attemptNumber"      INTEGER NOT NULL,

    "startedAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "finishedAt"         TIMESTAMPTZ(6),
    "durationMs"         INTEGER,

    "outcome"            "PublishAttemptOutcome" NOT NULL,
    "failureClass"       "PublishFailureClass",

    "providerStatusCode" INTEGER,
    "providerErrorCode"  TEXT,
    "safeSummary"        TEXT,

    "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "publish_attempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "publish_attempt"
  ADD CONSTRAINT "publish_attempt_summary_bounded"
  CHECK ("safeSummary" IS NULL OR length("safeSummary") <= 500);

ALTER TABLE "publish_attempt"
  ADD CONSTRAINT "publish_attempt_number_positive"
  CHECK ("attemptNumber" >= 1);

-- A FAILED ATTEMPT SAYS WHY, and a successful one does not pretend to.
ALTER TABLE "publish_attempt"
  ADD CONSTRAINT "publish_attempt_failure_class_matches_outcome"
  CHECK (
    ("outcome" = 'SUCCEEDED' AND "failureClass" IS NULL)
    OR ("outcome" <> 'SUCCEEDED' AND "failureClass" IS NOT NULL)
  );

CREATE UNIQUE INDEX "publish_attempt_workspaceId_publishJobId_attemptNumber_key"
  ON "publish_attempt" ("workspaceId", "publishJobId", "attemptNumber");
CREATE INDEX "publish_attempt_workspaceId_publishJobId_attemptNumber_idx"
  ON "publish_attempt" ("workspaceId", "publishJobId", "attemptNumber");

ALTER TABLE "publish_attempt"
  ADD CONSTRAINT "publish_attempt_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publish_attempt"
  ADD CONSTRAINT "publish_attempt_job_fkey"
  FOREIGN KEY ("workspaceId", "publishJobId") REFERENCES "publish_job"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE OR REPLACE FUNCTION app.publish_attempt_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'publish_attempt is append-only: an attempt record is evidence and may not be % after the fact',
    lower(TG_OP)
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION app.publish_attempt_is_append_only() IS
  'Phase 6: the publish evidence trail may be inserted and read, never rewritten.';

CREATE TRIGGER publish_attempt_no_update
  BEFORE UPDATE ON "publish_attempt"
  FOR EACH ROW EXECUTE FUNCTION app.publish_attempt_is_append_only();


-- ---------------------------------------------------------------------------
-- 9. Row-Level Security. ENABLED and FORCED on all five.
--
-- FORCE matters as much as ENABLE: without it the policy does not apply to the
-- table's OWNER, and a migration or a maintenance statement running as owner
-- would see every tenant at once (D-113).
-- ---------------------------------------------------------------------------

-- WRITTEN OUT ONE TABLE AT A TIME, not generated in a DO loop.
-- The D-29 gate READS THIS FILE AS TEXT to prove every tenant-owned table has
-- its policy, and a loop that builds the statements with `format()` is invisible
-- to it — the policies would exist and the gate that exists to prove they exist
-- would have nothing to read. Verbosity that a machine can check beats brevity
-- that it cannot.

ALTER TABLE "social_connection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_connection" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "social_connection"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "social_connection"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "social_connection" TO brandspace_app, brandspace_platform;

ALTER TABLE "social_credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_credential" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "social_credential"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "social_credential"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "social_credential" TO brandspace_app, brandspace_platform;

ALTER TABLE "social_oauth_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_oauth_state" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "social_oauth_state"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "social_oauth_state"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "social_oauth_state" TO brandspace_app, brandspace_platform;

ALTER TABLE "publish_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "publish_job" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "publish_job"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "publish_job"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "publish_job" TO brandspace_app, brandspace_platform;

ALTER TABLE "publish_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "publish_attempt" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "publish_attempt"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "publish_attempt"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "publish_attempt" TO brandspace_app, brandspace_platform;

-- ---------------------------------------------------------------------------
-- IMMUTABILITY IS A TRIGGER; NON-DELETABILITY IS A PRIVILEGE. The difference
-- matters, and the first draft got it wrong in a way only the existing suites
-- caught.
--
-- A BEFORE DELETE trigger fires for a CASCADED delete too, and PostgreSQL gives
-- a row trigger no way to tell one from a direct statement. So a trigger here
-- made every ordinary lifecycle operation fail the moment a single attempt
-- existed: deleting a calendar slot, a content item, a brand or a workspace all
-- cascade down to this table, and all of them started raising
-- "publish_attempt is append-only". The Phase 5B-2 and 5B-3 suites went red
-- against a table they know nothing about — which is exactly what a
-- cross-phase regression looks like.
--
-- REVOKING THE PRIVILEGE SAYS THE RIGHT THING INSTEAD. A cascade is performed
-- as the table owner and is unaffected; a DELETE issued BY the tenant is
-- refused outright. So an attempt cannot be edited, and cannot be removed from
-- a sequence to make a history read differently — while an attempt whose job no
-- longer exists goes with it, because evidence about a thing that has been
-- deleted has no subject.
--
-- The platform identity keeps DELETE: erasure on request is a platform
-- operation and must remain possible.
-- ---------------------------------------------------------------------------

REVOKE DELETE ON "publish_attempt" FROM brandspace_app;

-- ---------------------------------------------------------------------------
-- 10. ASSERT what was just done, rather than trusting it.
--
-- A migration that says it enabled RLS and did not is the worst possible
-- outcome: every later isolation test passes for the wrong reason.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'social_connection', 'social_credential', 'social_oauth_state',
    'publish_job', 'publish_attempt'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
       WHERE oid = format('%I', t)::regclass
         AND relrowsecurity IS TRUE
         AND relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '% must have RLS ENABLED and FORCED after this migration', t;
    END IF;
  END LOOP;
END $$;

-- AND THAT THE REVOKE SURVIVED THE GRANT. The two are four lines apart and
-- order-dependent: a GRANT after the REVOKE would silently restore the
-- privilege and the evidence trail would be tenant-deletable with nothing
-- saying so. Asserting it costs one query and removes the whole class of
-- mistake.
DO $$
BEGIN
  IF has_table_privilege('brandspace_app', 'publish_attempt', 'DELETE') THEN
    RAISE EXCEPTION
      'brandspace_app must NOT hold DELETE on publish_attempt: the evidence trail '
      'is removable only by a cascade from the job it belongs to';
  END IF;
  IF NOT has_table_privilege('brandspace_app', 'publish_attempt', 'INSERT') THEN
    RAISE EXCEPTION 'brandspace_app must still be able to INSERT publish attempts';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 11. Admit `publishing` to the tenant entitlement-catalogue projection.
--
-- The allowed-domain CHECK is a closed list on purpose — projecting a domain
-- makes it tenant-readable, which is a decision and not a default.
--
-- `publishing` earns it the way `content` did. The customer's own screens state
-- and enforce these values: the connected-accounts page has to say which
-- platforms can be connected at all, the composer has to know a platform cannot
-- take a carousel BEFORE the customer builds one, and the publishing history
-- has to explain a retry schedule that matches the one actually applied. A
-- dashboard that restated any of it would be a second setting that drifts from
-- the first (CLAUDE.md §2.2).
--
-- IT CARRIES NO CREDENTIAL. App ids, client-secret refs and webhook-secret refs
-- live in `integrations.social-apps`, which is NOT projected and never will be.
-- That separation is the whole reason this domain can be tenant-readable: what
-- a platform CAN do is public knowledge; what our app is allowed to do it WITH
-- is not.
-- ---------------------------------------------------------------------------

ALTER TABLE "entitlement_catalogue_snapshot"
  DROP CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains";

ALTER TABLE "entitlement_catalogue_snapshot"
  ADD CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains"
  CHECK ("domain" IN (
    'entitlements', 'plans', 'feature-flags', 'credits',
    'brand-brain', 'assets', 'content', 'publishing'
  ));

COMMIT;
