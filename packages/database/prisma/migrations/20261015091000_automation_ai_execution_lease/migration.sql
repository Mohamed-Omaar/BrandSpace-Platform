-- PHASE 2B-3 PR 6 (M5b) — the AI executor's lease on a run.
--
-- SCHEMA ONLY, ADDITIVE. Three columns and three CHECKs on "automation_run". No
-- row is inserted, updated or rewritten: every existing run gets NULL, NULL and
-- 0, which satisfies every CHECK. RLS, its policies and grants are untouched.
--
--   executionLeaseId     — who holds the run while it is EXECUTING. Every write
--                          that finishes or releases the run is guarded by it
--                          (compare-and-swap), so an executor whose lease
--                          expired can never finish a run another one took over.
--   executionAvailableAt — when the executor may next touch the run: the
--                          backoff for AWAITING_EXECUTION, the lease expiry for
--                          EXECUTING. One column, one partial index
--                          (`20261015092000_automation_run_execution_due_index`).
--   executionAttempts    — claims so far; bounded by `aiMaxAttempts` in the
--                          automations configuration, and by a CHECK here.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. Its Prisma client selects only the
-- columns it knows, and its inserts omit these three, which default to NULL,
-- NULL and 0.
--
-- LOCKING. Adding a nullable column, or one with a constant default, changes
-- metadata only. Each CHECK is validated by one scan of "automation_run" under
-- the ACCESS EXCLUSIVE lock the transaction already holds; the table is bounded
-- by run retention. A five-second lock timeout means this migration never
-- queues every request behind a long transaction: it gives up, rolls back
-- completely, and is deployed again (OPERATIONS §6.13).
--
-- FORWARD-ONLY (OPERATIONS §6): there is no down script.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "automation_run"
  ADD COLUMN "executionLeaseId" UUID,
  ADD COLUMN "executionAvailableAt" TIMESTAMPTZ(6),
  ADD COLUMN "executionAttempts" INTEGER NOT NULL DEFAULT 0;

-- An attempt count is never negative, and never grows without bound: the
-- configured maximum is at most 10, so 20 leaves room and still refuses a loop.
ALTER TABLE "automation_run"
  ADD CONSTRAINT "automation_run_execution_attempts_bounded"
  CHECK ("executionAttempts" BETWEEN 0 AND 20);

-- A lease exists exactly while the run is EXECUTING.
ALTER TABLE "automation_run"
  ADD CONSTRAINT "automation_run_execution_lease_matches_status"
  CHECK (("status" = 'EXECUTING') = ("executionLeaseId" IS NOT NULL));

-- A run waiting for, or held by, the executor always says when it is due, so
-- the due-run sweep can never lose one.
ALTER TABLE "automation_run"
  ADD CONSTRAINT "automation_run_execution_due_is_set"
  CHECK (
    "status" NOT IN ('AWAITING_EXECUTION', 'EXECUTING')
    OR "executionAvailableAt" IS NOT NULL
  );

COMMIT;
