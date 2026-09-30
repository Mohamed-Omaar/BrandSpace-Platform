-- PHASE 2B-3 PR 4 (M3, 2 of 3) — pooling one post's readings for the top-10%
-- ranking.
--
-- INDEX ONLY. No table, column, constraint, policy, grant or row is created,
-- changed or rewritten; RLS on "metric_observation" is untouched.
--
-- WHY. POST_TOP_10_PERCENT sums each candidate post's DAY `engagements` and
-- `impressions`. The existing (workspaceId, contentItemId) index reaches the
-- post but not the metric or the granularity.
--
-- NO LONG LOCK. `CREATE INDEX CONCURRENTLY` (SHARE UPDATE EXCLUSIVE) does not
-- block writes; the only statement in the file, so Prisma runs it outside a
-- transaction block. `IF NOT EXISTS` makes a re-run a no-op.
--
-- ROLLBACK. DROP INDEX CONCURRENTLY IF EXISTS
-- "metric_observation_item_metric_granularity_idx"; (OPERATIONS.md §6.10).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "metric_observation_item_metric_granularity_idx"
  ON "metric_observation" ("workspaceId", "contentItemId", "metricKey", "granularity");
