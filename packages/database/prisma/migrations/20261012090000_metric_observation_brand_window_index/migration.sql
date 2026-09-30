-- PHASE 2B-3 PR 4 (M3, 1 of 3) — the weekly-engagement window, without scanning
-- other granularities.
--
-- INDEX ONLY. No table, column, constraint, policy, grant or row is created,
-- changed or rewritten. RLS on "metric_observation" (ENABLE + FORCE) is
-- untouched: an index is not a policy and reads through it are still filtered
-- by the tenant policy.
--
-- WHY. WEEKLY_ENGAGEMENT_DROPPED sums one brand's DAY `engagements` over two
-- UTC weeks. The existing (workspaceId, brandId, metricKey, periodStart DESC)
-- index reaches the metric but not the granularity, so HOUR/WEEK/LIFETIME rows
-- of the same metric are read and discarded.
--
-- NO LONG LOCK. `CREATE INDEX CONCURRENTLY` takes SHARE UPDATE EXCLUSIVE, which
-- does not block INSERT, UPDATE or DELETE on the table while the index builds.
-- It cannot run inside a transaction block, so it is the ONLY statement in this
-- file: Prisma sends a single-statement migration outside any explicit
-- transaction. `IF NOT EXISTS` makes a re-run after an interrupted build a
-- no-op; an interrupted build can leave an INVALID index behind, which
-- OPERATIONS.md §6.10 says how to find and rebuild.
--
-- ROLLBACK. Not needed for an application rollback (the previous release
-- ignores the index). To remove it: DROP INDEX CONCURRENTLY IF EXISTS
-- "metric_observation_brand_metric_granularity_idx"; (OPERATIONS.md §6.10).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "metric_observation_brand_metric_granularity_idx"
  ON "metric_observation" ("workspaceId", "brandId", "metricKey", "granularity", "periodStart");
