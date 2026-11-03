-- PERF A (D-595, 1 of 3) — the top bar's failed-post count, on every page.
-- SQL approved by the owner as written, 2026-11-03.
--
-- INDEX ONLY. No table, column, constraint, policy, grant or row is created,
-- changed or rewritten. RLS on "calendar_slot" is untouched: an index is not a
-- policy and reads through it are still filtered by the tenant policy.
--
-- WHY. `count(*) WHERE "workspaceId" = $1 AND status IN ('FAILED',
-- 'PARTIALLY_PUBLISHED')` (apps/dashboard/src/server/topbar-counts.ts) runs on
-- every signed-in page; the existing indexes lead with (workspaceId,
-- scheduledAtUtc) or (status, scheduledAtUtc) and reach only one of the two.
--
-- NO LONG LOCK. `CREATE INDEX CONCURRENTLY` takes SHARE UPDATE EXCLUSIVE, which
-- does not block INSERT, UPDATE or DELETE while the index builds. It cannot run
-- inside a transaction block, so it is the ONLY statement in this file. `IF NOT
-- EXISTS` makes a re-run after an interrupted build a no-op; an interrupted build
-- can leave an INVALID index behind, which OPERATIONS.md §6.10 says how to find
-- and rebuild.
--
-- ROLLBACK. Not needed for an application rollback (the previous release
-- ignores the index). To remove it: DROP INDEX CONCURRENTLY IF EXISTS
-- "calendar_slot_workspaceId_status_idx"; (OPERATIONS.md §6.10).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "calendar_slot_workspaceId_status_idx"
  ON "calendar_slot" ("workspaceId", "status");
