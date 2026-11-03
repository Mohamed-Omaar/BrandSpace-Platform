-- PERF A (D-595, 3 of 3) — "BrandSpace noticed" on Home.
-- SQL approved by the owner as written, 2026-11-03.
--
-- INDEX ONLY. No table, column, constraint, policy, grant or row is created,
-- changed or rewritten. RLS on "audit_event" is untouched.
--
-- WHY. The noticed preferences and workflows (packages/content/src/
-- suggestions.ts) read one member's recent actions of two kinds in one
-- workspace: WHERE "workspaceId" = $1 AND "brandId" = $2 AND "actorId" = $3
-- AND action IN (...) AND "occurredAt" >= $4 ORDER BY "occurredAt" DESC.
--
-- NO LONG LOCK. `CREATE INDEX CONCURRENTLY` (SHARE UPDATE EXCLUSIVE), the ONLY
-- statement in this file. OPERATIONS.md §6.10 for an interrupted build.
--
-- ROLLBACK. Not needed for an application rollback. To remove it: DROP INDEX
-- CONCURRENTLY IF EXISTS "audit_event_workspaceId_actorId_action_occurredAt_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_event_workspaceId_actorId_action_occurredAt_idx"
  ON "audit_event" ("workspaceId", "actorId", "action", "occurredAt");
