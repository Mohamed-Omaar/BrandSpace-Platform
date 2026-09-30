-- PHASE 2B-3 PR 4 (M3, 3 of 3) — the top-10% population: a brand's posts
-- published in the last N days.
--
-- INDEX ONLY, and PARTIAL. No table, column, constraint, policy, grant or row
-- is created, changed or rewritten; RLS on "publish_job" is untouched. Only
-- PUBLISHED jobs are indexed, so the index stays small and a job that never
-- published costs nothing to maintain here beyond the predicate check.
--
-- WHY. The existing (workspaceId, brandId, status) index reaches the published
-- jobs of a brand but not their `publishedAt`, which bounds the window.
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
-- "publish_job_published_population_idx"; (OPERATIONS.md §6.10).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "publish_job_published_population_idx"
  ON "publish_job" ("workspaceId", "brandId", "publishedAt")
  WHERE "status" = 'PUBLISHED';
