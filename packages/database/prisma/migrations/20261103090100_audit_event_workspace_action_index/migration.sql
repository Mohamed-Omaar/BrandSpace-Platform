-- PERF A (D-595, 2 of 3) — the Activity filter's options.
-- SQL approved by the owner as written, 2026-11-03.
--
-- INDEX ONLY. No table, column, constraint, policy, grant or row is created,
-- changed or rewritten. RLS on "audit_event" is untouched.
--
-- WHY. `SELECT action ... WHERE "workspaceId" = $1 AND <scope> GROUP BY action
-- ORDER BY action LIMIT 200` (packages/activity/src/service.ts, actions()); no
-- existing audit index groups one workspace's actions.
--
-- NO LONG LOCK. `CREATE INDEX CONCURRENTLY` (SHARE UPDATE EXCLUSIVE): INSERT,
-- UPDATE and DELETE carry on while it builds — audit_event is written on every
-- mutation. The ONLY statement in this file, so Prisma sends it outside any
-- transaction. OPERATIONS.md §6.10 for an interrupted build.
--
-- ROLLBACK. Not needed for an application rollback. To remove it: DROP INDEX
-- CONCURRENTLY IF EXISTS "audit_event_workspaceId_action_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_event_workspaceId_action_idx"
  ON "audit_event" ("workspaceId", "action");
