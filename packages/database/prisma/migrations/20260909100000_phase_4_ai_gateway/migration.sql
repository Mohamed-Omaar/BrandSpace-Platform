-- Phase 4 — the AI Gateway's two tables.
--
-- `ai_request` is one logical AI action; `ai_usage_ledger` is the immutable
-- financial record of what it cost and what the customer was charged
-- (docs/DATABASE.md §6.5–6.6, docs/AI-GATEWAY.md §12).
--
-- Both are TENANT-OWNED. An AI request records what a workspace asked for and
-- the ledger what it was billed; neither may cross a tenant boundary, so both
-- get RLS, both are registered in `tenant-models.ts`, and both carry isolation
-- tests. The D-29 gate fails the build otherwise.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "AiRequestStatus" AS ENUM (
  'PENDING', 'RESERVED', 'RUNNING',
  'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'MODERATION_BLOCKED'
);

CREATE TYPE "AiFailureClass" AS ENUM (
  'AUTH_ERROR', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'INVALID_REQUEST',
  'CONTENT_FILTERED', 'CONTEXT_TOO_LONG', 'MODEL_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN'
);

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

CREATE TABLE "ai_request" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "userId"      UUID,

  "taskKey"        TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,

  "routingTaskKey"     TEXT,
  "resolvedModelKey"   TEXT,
  "attemptedModelKeys" TEXT[] NOT NULL DEFAULT '{}',

  "status"         "AiRequestStatus" NOT NULL DEFAULT 'PENDING',
  "failureClass"   "AiFailureClass",
  "failureMessage" TEXT,

  -- Audit-safe metadata only. docs/AI-GATEWAY.md §11: raw prompts and
  -- responses are NOT persisted by default.
  "inputSummary" JSONB,

  "promptTokens"     INTEGER,
  "completionTokens" INTEGER,
  "imageCount"       INTEGER,
  "durationSeconds"  INTEGER,

  "providerCostMinor" INTEGER NOT NULL DEFAULT 0,
  "currency"          CHAR(3) NOT NULL DEFAULT 'USD',

  "creditsReservedMilli" BIGINT NOT NULL DEFAULT 0,
  "creditsChargedMilli"  BIGINT NOT NULL DEFAULT 0,

  "creditReservationId" UUID,

  "latencyMs"  INTEGER,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "byok"       BOOLEAN NOT NULL DEFAULT false,

  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "startedAt"   TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "deadlineAt"  TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "ai_request_workspace_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE,

  -- Credits are never negative, and a charge never exceeds what was reserved:
  -- the settle path narrows the reservation, it does not widen it.
  CONSTRAINT "ai_request_credits_nonnegative"
    CHECK ("creditsReservedMilli" >= 0 AND "creditsChargedMilli" >= 0),
  CONSTRAINT "ai_request_charge_within_reservation"
    CHECK ("creditsChargedMilli" <= "creditsReservedMilli"),
  CONSTRAINT "ai_request_provider_cost_nonnegative"
    CHECK ("providerCostMinor" >= 0),

  -- A request that has not succeeded has charged nothing. This is
  -- docs/AI-GATEWAY.md §7.4 guarantee 1 ("no charge for failure") expressed
  -- where it cannot be forgotten, rather than only in the code that settles.
  CONSTRAINT "ai_request_no_charge_unless_succeeded"
    CHECK ("status" = 'SUCCEEDED' OR "creditsChargedMilli" = 0)
);

-- One request, one reservation.
CREATE UNIQUE INDEX "ai_request_idempotencyKey_key" ON "ai_request" ("idempotencyKey");
CREATE UNIQUE INDEX "ai_request_creditReservationId_key"
  ON "ai_request" ("creditReservationId") WHERE "creditReservationId" IS NOT NULL;

CREATE INDEX "ai_request_workspaceId_createdAt_idx"
  ON "ai_request" ("workspaceId", "createdAt" DESC);
CREATE INDEX "ai_request_workspaceId_taskKey_status_idx"
  ON "ai_request" ("workspaceId", "taskKey", "status");
-- The stuck-request sweep. Ordered by deadline so the oldest is reconciled
-- first — the A-7 lesson applied before the defect rather than after it.
CREATE INDEX "ai_request_status_deadlineAt_idx" ON "ai_request" ("status", "deadlineAt");

CREATE TABLE "ai_usage_ledger" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "aiRequestId" UUID NOT NULL,
  "userId"      UUID,

  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  "taskKey"     TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "modelKey"    TEXT NOT NULL,

  "usageUnits" JSONB NOT NULL,

  "providerCostMinor"   INTEGER NOT NULL DEFAULT 0,
  "currency"            CHAR(3) NOT NULL DEFAULT 'USD',
  "creditsChargedMilli" BIGINT  NOT NULL DEFAULT 0,

  "creditTransactionId" UUID,

  "byok"        BOOLEAN NOT NULL DEFAULT false,
  "environment" "DeploymentEnvironment" NOT NULL,

  "correctsLedgerId" UUID,

  CONSTRAINT "ai_usage_ledger_workspace_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE,
  CONSTRAINT "ai_usage_ledger_request_fkey"
    FOREIGN KEY ("aiRequestId") REFERENCES "ai_request"("id") ON DELETE CASCADE,
  CONSTRAINT "ai_usage_ledger_corrects_fkey"
    FOREIGN KEY ("correctsLedgerId") REFERENCES "ai_usage_ledger"("id") ON DELETE RESTRICT,

  CONSTRAINT "ai_usage_ledger_amounts_nonnegative"
    CHECK ("providerCostMinor" >= 0 AND "creditsChargedMilli" >= 0)
);

CREATE INDEX "ai_usage_ledger_workspaceId_occurredAt_idx"
  ON "ai_usage_ledger" ("workspaceId", "occurredAt" DESC);
CREATE INDEX "ai_usage_ledger_workspaceId_taskKey_occurredAt_idx"
  ON "ai_usage_ledger" ("workspaceId", "taskKey", "occurredAt");
CREATE INDEX "ai_usage_ledger_modelKey_occurredAt_idx"
  ON "ai_usage_ledger" ("modelKey", "occurredAt");

-- ---------------------------------------------------------------------------
-- 3. The ledger is APPEND-ONLY, enforced by the database.
--
-- docs/DATABASE.md §6.6: "Append-only. No updates, no deletes. Corrections are
-- new rows referencing `correctsLedgerId`." Revoking the privilege is the
-- primary control; the trigger is the second one, because a future migration
-- that re-grants UPDATE by accident would otherwise silently reopen it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ai_usage_ledger_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'ai_usage_ledger is append-only; corrections are new rows referencing correctsLedgerId';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_usage_ledger_no_update
  BEFORE UPDATE OR DELETE ON "ai_usage_ledger"
  FOR EACH ROW EXECUTE FUNCTION ai_usage_ledger_is_append_only();

-- ---------------------------------------------------------------------------
-- 4. Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE "ai_request"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_request"       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "ai_usage_ledger"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage_ledger"  FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ai_request"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "ai_usage_ledger"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "ai_request"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "ai_usage_ledger"
  TO brandspace_platform USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 5. Privileges
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_request" TO brandspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_request" TO brandspace_platform;

GRANT SELECT, INSERT ON "ai_usage_ledger" TO brandspace_app;
GRANT SELECT, INSERT ON "ai_usage_ledger" TO brandspace_platform;

-- Said explicitly as well as omitted from the GRANT above, so a reader of this
-- migration sees the intent rather than inferring it from an absence.
REVOKE UPDATE, DELETE ON "ai_usage_ledger" FROM brandspace_app;
REVOKE UPDATE, DELETE ON "ai_usage_ledger" FROM brandspace_platform;
