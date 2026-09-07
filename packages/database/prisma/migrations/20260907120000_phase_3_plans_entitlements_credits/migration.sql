-- ===========================================================================
-- Phase 3 — plans, entitlements, credits.
--
-- Six new tenant-owned tables, every one carrying `workspaceId` and every one
-- protected by the same construction Phase 1 established: ENABLE + FORCE row
-- level security, a policy scoped to `brandspace_app` keyed on
-- `app.current_workspace_id()`, a platform policy for the audited cross-tenant
-- role, and explicit grants (the Phase 1 blanket `ALL TABLES` grant only ever
-- covered the tables that existed then).
--
-- Two of them are append-only in the same sense as `audit_event` and
-- `credit_transaction`: `usage_event` is an idempotency record and
-- `credit_grant`'s creating transaction is unique. Where history must not be
-- rewritten the privilege is revoked AND a trigger refuses the write, so
-- removing one control alone does not open the door.
-- ===========================================================================

-- Enums ---------------------------------------------------------------------

-- New members of an existing type. PostgreSQL 12+ permits this inside a
-- transaction block provided the new value is not USED in the same
-- transaction; nothing below references them.
ALTER TYPE "CreditTransactionType" ADD VALUE IF NOT EXISTS 'ADDON_PURCHASE';
ALTER TYPE "CreditTransactionType" ADD VALUE IF NOT EXISTS 'TRIAL_GRANT';

CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');
CREATE TYPE "CreditGrantSource" AS ENUM ('PLAN_GRANT', 'TRIAL_GRANT', 'PROMOTIONAL_GRANT', 'PACK_PURCHASE', 'ADMIN_ADJUSTMENT', 'ROLLOVER');
CREATE TYPE "CreditReservationStatus" AS ENUM ('OPEN', 'SETTLED', 'RELEASED', 'EXPIRED');

-- Existing tables gain Phase 3 columns ---------------------------------------

ALTER TABLE "credit_wallet"
  ADD COLUMN "lastResetAt"               TIMESTAMPTZ(6),
  ADD COLUMN "nextResetAt"               TIMESTAMPTZ(6),
  ADD COLUMN "lowBalanceNotifiedAt"      TIMESTAMPTZ(6),
  ADD COLUMN "lowBalanceNotifiedPercent" INTEGER;

ALTER TABLE "credit_transaction"
  ADD COLUMN "expiresAt"     TIMESTAMPTZ(6),
  ADD COLUMN "sourceGrantId" UUID,
  ADD COLUMN "reservationId" UUID;

CREATE INDEX "credit_transaction_workspaceId_expiresAt_idx"
  ON "credit_transaction" ("workspaceId", "expiresAt");
CREATE INDEX "credit_transaction_reservationId_idx"
  ON "credit_transaction" ("reservationId");

-- workspace_subscription -----------------------------------------------------

CREATE TABLE "workspace_subscription" (
  "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId"            UUID NOT NULL,
  "planKey"                TEXT NOT NULL,
  "status"                 "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
  "billingInterval"        "BillingInterval" NOT NULL DEFAULT 'MONTH',
  "currency"               CHAR(3) NOT NULL,
  "pinnedMonthlyMinor"     INTEGER NOT NULL,
  "pinnedAnnualMinor"      INTEGER NOT NULL,
  "pinnedFromVersionId"    UUID,
  "pinnedMonthlyCredits"   INTEGER NOT NULL DEFAULT 0,
  "currentPeriodStart"     TIMESTAMPTZ(6) NOT NULL,
  "currentPeriodEnd"       TIMESTAMPTZ(6) NOT NULL,
  "trialStartedAt"         TIMESTAMPTZ(6),
  "trialEndsAt"            TIMESTAMPTZ(6),
  "pendingPlanKey"         TEXT,
  "pendingPlanEffectiveAt" TIMESTAMPTZ(6),
  "cancelAtPeriodEnd"      BOOLEAN NOT NULL DEFAULT false,
  "cancelledAt"            TIMESTAMPTZ(6),
  "createdAt"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"              TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "workspace_subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_subscription_workspaceId_key"
  ON "workspace_subscription" ("workspaceId");
CREATE INDEX "workspace_subscription_status_currentPeriodEnd_idx"
  ON "workspace_subscription" ("status", "currentPeriodEnd");
CREATE INDEX "workspace_subscription_planKey_idx"
  ON "workspace_subscription" ("planKey");

ALTER TABLE "workspace_subscription"
  ADD CONSTRAINT "workspace_subscription_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A period that ends before it starts would make every cycle computation wrong
-- in a way no test would notice until a grant ran.
ALTER TABLE "workspace_subscription"
  ADD CONSTRAINT "workspace_subscription_period_ordered"
  CHECK ("currentPeriodEnd" > "currentPeriodStart");

-- credit_grant ---------------------------------------------------------------

CREATE TABLE "credit_grant" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId"           UUID NOT NULL,
  "walletId"              UUID NOT NULL,
  "source"                "CreditGrantSource" NOT NULL,
  "amountMilliCredits"    BIGINT NOT NULL,
  "remainingMilliCredits" BIGINT NOT NULL,
  "reservedMilliCredits"  BIGINT NOT NULL DEFAULT 0,
  "expiresAt"             TIMESTAMPTZ(6),
  "sourceTransactionId"   UUID NOT NULL,
  "reason"                TEXT NOT NULL,
  "grantedAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "credit_grant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_grant_sourceTransactionId_key"
  ON "credit_grant" ("sourceTransactionId");
CREATE INDEX "credit_grant_workspaceId_expiresAt_grantedAt_idx"
  ON "credit_grant" ("workspaceId", "expiresAt", "grantedAt");
CREATE INDEX "credit_grant_walletId_remainingMilliCredits_idx"
  ON "credit_grant" ("walletId", "remainingMilliCredits");

ALTER TABLE "credit_grant"
  ADD CONSTRAINT "credit_grant_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_grant"
  ADD CONSTRAINT "credit_grant_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "credit_wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The same class of guarantee as CHECK (currentBalance >= 0) on the wallet: a
-- bucket can never be over-drawn, and can never hold more than it was granted,
-- whatever application code believes.
ALTER TABLE "credit_grant"
  ADD CONSTRAINT "credit_grant_remaining_within_amount"
  CHECK ("remainingMilliCredits" >= 0 AND "remainingMilliCredits" <= "amountMilliCredits");

-- A bucket can never hold more than it still has. This is the per-bucket
-- equivalent of the wallet's CHECK (balance >= 0), and it is what stops two
-- concurrent reservations from both allocating the same credits.
ALTER TABLE "credit_grant"
  ADD CONSTRAINT "credit_grant_reserved_within_remaining"
  CHECK ("reservedMilliCredits" >= 0 AND "reservedMilliCredits" <= "remainingMilliCredits");
ALTER TABLE "credit_grant"
  ADD CONSTRAINT "credit_grant_amount_positive"
  CHECK ("amountMilliCredits" > 0);

-- credit_reservation ---------------------------------------------------------

CREATE TABLE "credit_reservation" (
  "id"                   UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId"          UUID NOT NULL,
  "walletId"             UUID NOT NULL,
  "idempotencyKey"       TEXT NOT NULL,
  "estimateMilliCredits" BIGINT NOT NULL,
  "settledMilliCredits"  BIGINT,
  "status"               "CreditReservationStatus" NOT NULL DEFAULT 'OPEN',
  "allocations"          JSONB NOT NULL,
  "purpose"              TEXT NOT NULL,
  "expiresAt"            TIMESTAMPTZ(6) NOT NULL,
  "createdAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "settledAt"            TIMESTAMPTZ(6),
  "releasedAt"           TIMESTAMPTZ(6),
  "releaseReason"        TEXT,
  CONSTRAINT "credit_reservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_reservation_idempotencyKey_key"
  ON "credit_reservation" ("idempotencyKey");
CREATE INDEX "credit_reservation_workspaceId_status_idx"
  ON "credit_reservation" ("workspaceId", "status");
CREATE INDEX "credit_reservation_status_expiresAt_idx"
  ON "credit_reservation" ("status", "expiresAt");

ALTER TABLE "credit_reservation"
  ADD CONSTRAINT "credit_reservation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_reservation"
  ADD CONSTRAINT "credit_reservation_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "credit_wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "credit_reservation"
  ADD CONSTRAINT "credit_reservation_estimate_positive"
  CHECK ("estimateMilliCredits" > 0);

-- Settlement may cost less than the estimate; it may NEVER cost more. Charging
-- above the reserved amount is the one way a wallet could go negative behind
-- the wallet's own CHECK, so the database refuses it directly.
ALTER TABLE "credit_reservation"
  ADD CONSTRAINT "credit_reservation_settled_within_estimate"
  CHECK ("settledMilliCredits" IS NULL
      OR ("settledMilliCredits" >= 0 AND "settledMilliCredits" <= "estimateMilliCredits"));

-- usage_counter --------------------------------------------------------------

CREATE TABLE "usage_counter" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "featureKey"  TEXT NOT NULL,
  "periodStart" TIMESTAMPTZ(6) NOT NULL,
  "periodEnd"   TIMESTAMPTZ(6) NOT NULL,
  "usedValue"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "usage_counter_pkey" PRIMARY KEY ("id")
);

-- The unique key is what makes `INSERT … ON CONFLICT DO UPDATE` an atomic
-- check-and-increment rather than a read followed by a hopeful write.
CREATE UNIQUE INDEX "usage_counter_workspaceId_featureKey_periodStart_key"
  ON "usage_counter" ("workspaceId", "featureKey", "periodStart");
CREATE INDEX "usage_counter_workspaceId_featureKey_periodEnd_idx"
  ON "usage_counter" ("workspaceId", "featureKey", "periodEnd");

ALTER TABLE "usage_counter"
  ADD CONSTRAINT "usage_counter_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "usage_counter"
  ADD CONSTRAINT "usage_counter_used_non_negative" CHECK ("usedValue" >= 0);

-- usage_event ----------------------------------------------------------------

CREATE TABLE "usage_event" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId"    UUID NOT NULL,
  "featureKey"     TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "amount"         INTEGER NOT NULL,
  "counterId"      UUID NOT NULL,
  "occurredAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "usage_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "usage_event_idempotencyKey_key"
  ON "usage_event" ("idempotencyKey");
CREATE INDEX "usage_event_workspaceId_featureKey_occurredAt_idx"
  ON "usage_event" ("workspaceId", "featureKey", "occurredAt" DESC);

ALTER TABLE "usage_event"
  ADD CONSTRAINT "usage_event_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- beta_cohort_membership -----------------------------------------------------

CREATE TABLE "beta_cohort_membership" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId"           UUID NOT NULL,
  "cohortKey"             TEXT NOT NULL,
  "addedByPlatformUserId" UUID NOT NULL,
  "reason"                TEXT NOT NULL,
  "addedAt"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "beta_cohort_membership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "beta_cohort_membership_workspaceId_cohortKey_key"
  ON "beta_cohort_membership" ("workspaceId", "cohortKey");
CREATE INDEX "beta_cohort_membership_cohortKey_idx"
  ON "beta_cohort_membership" ("cohortKey");

ALTER TABLE "beta_cohort_membership"
  ADD CONSTRAINT "beta_cohort_membership_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security
-- ===========================================================================

ALTER TABLE "workspace_subscription"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_subscription"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "credit_grant"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_grant"            FORCE  ROW LEVEL SECURITY;
ALTER TABLE "credit_reservation"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_reservation"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "usage_counter"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_counter"           FORCE  ROW LEVEL SECURITY;
ALTER TABLE "usage_event"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_event"             FORCE  ROW LEVEL SECURITY;
ALTER TABLE "beta_cohort_membership"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "beta_cohort_membership"  FORCE  ROW LEVEL SECURITY;

-- Tenant policies. Identical predicate on every table: the row's workspace must
-- be the request's workspace. `NULL = <uuid>` is never true, so a query with no
-- workspace context reads nothing rather than everything.

CREATE POLICY tenant_isolation ON "workspace_subscription"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "credit_grant"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "credit_reservation"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "usage_counter"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "usage_event"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "beta_cohort_membership"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Platform policies. The audited cross-tenant role.

CREATE POLICY platform_access ON "workspace_subscription"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "credit_grant"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "credit_reservation"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "usage_counter"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "usage_event"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "beta_cohort_membership"
  TO brandspace_platform USING (true) WITH CHECK (true);

-- Privileges. Explicit, because the Phase 1 `ALL TABLES` grant only covered the
-- tables that existed when it ran.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "workspace_subscription", "credit_grant", "credit_reservation",
  "usage_counter", "usage_event", "beta_cohort_membership"
  TO brandspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "workspace_subscription", "credit_grant", "credit_reservation",
  "usage_counter", "usage_event", "beta_cohort_membership"
  TO brandspace_platform;

-- `usage_event` exists ONLY to make a repeated recording fail. If a caller could
-- delete its own idempotency record, the guarantee would be advisory. Append-
-- only for both roles, exactly like the ledger.
REVOKE UPDATE, DELETE ON "usage_event" FROM brandspace_app;
REVOKE UPDATE, DELETE ON "usage_event" FROM brandspace_platform;

-- ===========================================================================
-- Immutability triggers — the second stop, so a later migration that forgets a
-- REVOKE still cannot rewrite history.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.refuse_usage_event_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'usage_event is append-only: a usage record is never updated or deleted.';
END;
$$;

CREATE TRIGGER usage_event_is_append_only
  BEFORE UPDATE OR DELETE ON "usage_event"
  FOR EACH ROW EXECUTE FUNCTION app.refuse_usage_event_rewrite();

-- A grant's ORIGINAL amount and its provenance are history; only the remaining
-- balance moves. Letting `amountMilliCredits` or `sourceTransactionId` change
-- would break ledger replay silently — reconciliation would still report zero
-- drift while the numbers underneath had been rewritten.
CREATE OR REPLACE FUNCTION app.refuse_credit_grant_history_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."amountMilliCredits" IS DISTINCT FROM OLD."amountMilliCredits"
     OR NEW."sourceTransactionId" IS DISTINCT FROM OLD."sourceTransactionId"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
     OR NEW."grantedAt" IS DISTINCT FROM OLD."grantedAt" THEN
    RAISE EXCEPTION
      'A credit grant''s amount, source, workspace and provenance are immutable; only the remaining balance may change.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credit_grant_history_is_immutable
  BEFORE UPDATE ON "credit_grant"
  FOR EACH ROW EXECUTE FUNCTION app.refuse_credit_grant_history_rewrite();

-- A settled or released reservation is finished. Re-opening one would allow the
-- same estimate to be charged twice.
CREATE OR REPLACE FUNCTION app.refuse_reservation_reopen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'OPEN' AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION
      'A % reservation is terminal and cannot change state again.', OLD."status";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credit_reservation_is_terminal
  BEFORE UPDATE ON "credit_reservation"
  FOR EACH ROW EXECUTE FUNCTION app.refuse_reservation_reopen();
