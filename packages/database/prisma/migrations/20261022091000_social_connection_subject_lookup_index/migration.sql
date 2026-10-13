-- Connectors step B (approved as written) — B2 of 3: the subject lookup index.
--
-- INDEX ONLY, and the ONLY statement in this file: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block (the M3 convention, OPERATIONS §6.10).
-- It takes SHARE UPDATE EXCLUSIVE, so writes continue while it builds.
--
-- A deauthorize or data-deletion callback names a platform user; the API hashes
-- it (W10) and finds that person's connections ACROSS workspaces with the
-- platform role, then acts on each inside its own workspace's context (F-07).
-- Partial: only connections that carry a hash. Not unique: one person can
-- connect in several workspaces and brands. Leads with "provider" so a hash
-- can never match another platform's connection.
-- Rollback (not needed for an app rollback): DROP INDEX CONCURRENTLY IF EXISTS
-- "social_connection_provider_subject_hash_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "social_connection_provider_subject_hash_idx"
  ON "social_connection" ("provider", "providerSubjectHash")
  WHERE "providerSubjectHash" IS NOT NULL;
