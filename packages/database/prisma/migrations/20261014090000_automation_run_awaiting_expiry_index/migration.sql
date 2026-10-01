-- PHASE 2B-3 PR 5 (M4) — the asks-first lapse sweep: requests still waiting
-- whose window has closed.
--
-- INDEX ONLY, and PARTIAL. No table, column, constraint, policy, grant or row
-- is created, changed or rewritten; RLS on "automation_run" is untouched. Only
-- runs AWAITING_CONFIRMATION are indexed, so the index holds the open requests
-- and nothing else — a few rows per workspace, however many runs have ever run.
--
-- WHY. The sweep asks, platform-wide, for waiting runs whose
-- `confirmationExpiresAt` has passed, oldest first. The only index carrying
-- `status` is (workspaceId, brandId, status), where status is not the leading
-- column, so the sweep scanned all of it and sorted the result.
--
-- NOT IN schema.prisma. Prisma cannot declare a partial index; like the other
-- partial indexes in this schema it lives in its migration, with a pointer from
-- the model's comment.
--
-- NO LONG LOCK. `CREATE INDEX CONCURRENTLY` (SHARE UPDATE EXCLUSIVE) does not
-- block writes; the only statement in the file, so Prisma runs it outside a
-- transaction block. `IF NOT EXISTS` makes a re-run a no-op.
--
-- ROLLBACK. DROP INDEX CONCURRENTLY IF EXISTS
-- "automation_run_awaiting_expiry_idx"; (OPERATIONS.md §6.12). An interrupted
-- build leaves an INVALID index: OPERATIONS.md §6.10.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "automation_run_awaiting_expiry_idx"
  ON "automation_run" ("confirmationExpiresAt")
  WHERE "status" = 'AWAITING_CONFIRMATION';
