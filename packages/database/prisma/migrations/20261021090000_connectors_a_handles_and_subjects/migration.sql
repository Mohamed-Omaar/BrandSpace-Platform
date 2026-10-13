-- Connectors step A (readiness, D-505) — four columns for W5 and W10.
--
-- SCHEMA ONLY, ADDITIVE. Four nullable text columns on four tenant tables, each
-- with a shape CHECK, in one transaction. No row is inserted, updated or
-- rewritten; no table, enum value or index is added; RLS, its policies and grants
-- are untouched: every column belongs to a row the tenant policies already guard,
-- and the four tables are granted at table level.
--
--   publish_job.providerHandle            — W5. The platform's handle for a publish
--                                           it accepted and has not finished (a
--                                           media container id, a publish id). The
--                                           job is then VERIFICATION_PENDING and the
--                                           verify job asks about the handle; it is
--                                           never sent again.
--   publish_attempt.providerHandle        — W5. The same handle on the attempt that
--                                           received it.
--   social_connection.providerSubjectHash — W10. "v<n>:" + hex HMAC-SHA256 of the
--                                           provider's USER id for the grant, under
--                                           key version n (a Secret Service pepper
--                                           resolved only by the API). Never the raw
--                                           id. The version travels with the hash so
--                                           a key rotation never breaks a lookup.
--   social_oauth_state.pendingSubjectHash — W10. The same value, carried through the
--                                           page-selection pause (D-142).
--
-- NOT HERE (step B, with the code that reads them): the subject and handle lookup
-- indexes, the inbound-event table and the data-deletion table.
--
-- EVERY EXISTING ROW SATISFIES EVERY CHECK: each column is added in this same
-- transaction, so every row is NULL.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. Its Prisma client selects only the
-- columns it knows, and its inserts omit these, which default to NULL.
--
-- LOCKING. Nullable columns change metadata only (PostgreSQL 11+). Each CHECK is
-- validated by a scan under the ACCESS EXCLUSIVE lock the transaction already
-- holds. A five-second lock timeout means this migration never queues every
-- request behind a long transaction: it gives up, rolls back completely, and is
-- deployed again (OPERATIONS §6.13).
--
-- FORWARD-ONLY (OPERATIONS §6): there is no down script.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "publish_job"
  ADD COLUMN "providerHandle" TEXT;

ALTER TABLE "publish_job"
  ADD CONSTRAINT "publish_job_provider_handle_shape"
  CHECK ("providerHandle" IS NULL OR char_length("providerHandle") BETWEEN 1 AND 512);

ALTER TABLE "publish_attempt"
  ADD COLUMN "providerHandle" TEXT;

ALTER TABLE "publish_attempt"
  ADD CONSTRAINT "publish_attempt_provider_handle_shape"
  CHECK ("providerHandle" IS NULL OR char_length("providerHandle") BETWEEN 1 AND 512);

ALTER TABLE "social_connection"
  ADD COLUMN "providerSubjectHash" TEXT;

ALTER TABLE "social_connection"
  ADD CONSTRAINT "social_connection_provider_subject_hash_shape"
  CHECK ("providerSubjectHash" IS NULL OR "providerSubjectHash" ~ '^v[0-9]{1,4}:[0-9a-f]{64}$');

ALTER TABLE "social_oauth_state"
  ADD COLUMN "pendingSubjectHash" TEXT;

ALTER TABLE "social_oauth_state"
  ADD CONSTRAINT "social_oauth_state_pending_subject_hash_shape"
  CHECK ("pendingSubjectHash" IS NULL OR "pendingSubjectHash" ~ '^v[0-9]{1,4}:[0-9a-f]{64}$');

-- PROVE IT: RLS still enabled and forced on all four tables.
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['publish_job', 'publish_attempt', 'social_connection', 'social_oauth_state']) AS name
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_class
      WHERE relname = name
        AND relnamespace = 'public'::regnamespace
        AND relkind = 'r'
        AND relrowsecurity
        AND relforcerowsecurity
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'connectors A: RLS not enabled and forced on %', missing;
  END IF;
END
$$;

COMMIT;
