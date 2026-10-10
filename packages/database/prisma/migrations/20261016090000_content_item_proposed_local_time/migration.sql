-- BATCH 7 PR C (Fix PR 2a, B1.0) — a proposed publish time on a post.
--
-- SCHEMA ONLY, ADDITIVE. One nullable column and one CHECK on "content_item".
-- No row is inserted, updated or rewritten: every existing post gets NULL,
-- which satisfies the CHECK. RLS, its policies and grants are untouched: the
-- column belongs to a row the tenant policies already guard.
--
--   proposedLocalTime — the wall-clock time the author wants the post to go
--                       out, as `YYYY-MM-DDTHH:mm` in the workspace's zone (the
--                       form `calendar_slot.scheduledLocalTime` stores). It is
--                       a PROPOSAL: nothing publishes it. Only a SCHEDULED
--                       calendar slot is ever published, and a slot is made
--                       from this value by an explicit Schedule press or by
--                       "Approve & schedule", through the unchanged schedule()
--                       with its lead, horizon, quota and channel checks.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. Its Prisma client selects only the
-- columns it knows, and its inserts omit this one, which defaults to NULL.
--
-- LOCKING. Adding a nullable column changes metadata only. The CHECK is
-- validated by one scan of "content_item" under the ACCESS EXCLUSIVE lock the
-- transaction already holds. A five-second lock timeout means this migration
-- never queues every request behind a long transaction: it gives up, rolls back
-- completely, and is deployed again (OPERATIONS §6.13).
--
-- FORWARD-ONLY (OPERATIONS §6): there is no down script.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "content_item"
  ADD COLUMN "proposedLocalTime" TEXT;

-- The same wall-clock shape as a calendar slot's, or nothing.
ALTER TABLE "content_item"
  ADD CONSTRAINT "content_item_proposed_local_time_shape"
  CHECK (
    "proposedLocalTime" IS NULL
    OR "proposedLocalTime" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'
  );

COMMIT;
