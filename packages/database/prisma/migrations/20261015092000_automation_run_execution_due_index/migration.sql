-- PHASE 2B-3 PR 6 (M5b, its index) — the AI executor's due runs.
--
-- INDEX ONLY, and PARTIAL. No table, column, constraint, policy, grant or row
-- is created, changed or rewritten. Only runs AWAITING_EXECUTION or EXECUTING
-- are indexed, so the index holds the AI runs in flight and nothing else.
--
-- WHY. The executor asks, platform-wide, for runs whose `executionAvailableAt`
-- has passed, oldest first: waiting runs that are due, and runs whose lease
-- expired. Without it that question scans every run.
--
-- ITS OWN FILE. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction
-- block, so it is the file's single statement and Prisma runs it outside one
-- (the M4 pattern, `20261014090000_automation_run_awaiting_expiry_index`).
--
-- NO LONG LOCK. CONCURRENTLY takes SHARE UPDATE EXCLUSIVE and does not block
-- writes. `IF NOT EXISTS` makes a re-run a no-op.
--
-- NOT IN schema.prisma. Prisma cannot declare a partial index; the model's
-- comment points here.
--
-- ROLLBACK. DROP INDEX CONCURRENTLY IF EXISTS "automation_run_execution_due_idx";
-- an interrupted build leaves an INVALID index: OPERATIONS §6.13.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "automation_run_execution_due_idx"
  ON "automation_run" ("executionAvailableAt")
  WHERE "status" IN ('AWAITING_EXECUTION', 'EXECUTING');
