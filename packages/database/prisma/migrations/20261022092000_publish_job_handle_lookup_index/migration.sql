-- Connectors step B (approved as written) — B3 of 3: the handle lookup index.
--
-- INDEX ONLY, and the ONLY statement in this file (CREATE INDEX CONCURRENTLY,
-- outside any transaction; OPERATIONS §6.10).
--
-- A webhook about a media container or an asynchronous publish names the
-- platform's handle (W5); the API finds the one job waiting on it with the
-- platform role, then settles it inside its workspace. Partial: only the jobs
-- that have a handle (VERIFICATION_PENDING and their history), a small subset.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS "publish_job_provider_handle_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "publish_job_provider_handle_idx"
  ON "publish_job" ("provider", "providerHandle")
  WHERE "providerHandle" IS NOT NULL;
