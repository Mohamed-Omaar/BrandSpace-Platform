-- BATCH 7 PR C (Fix PR 2a B1.0 and Option B) — when a post goes out.
--
-- SCHEMA ONLY, ADDITIVE. Two columns, one enum type and two CHECKs on
-- "content_item", in one transaction. No row is inserted, updated or
-- rewritten, and RLS, its policies and grants are untouched: the columns
-- belong to a row the tenant policies already guard.
--
--   proposedLocalTime — the wall-clock time the author wants the post to go
--                       out, as `YYYY-MM-DDTHH:mm` in the workspace's zone (the
--                       form `calendar_slot.scheduledLocalTime` stores). A
--                       PROPOSAL: nothing publishes it. A slot is made from it
--                       only by the Studio's Schedule press or by "Approve &
--                       schedule", through the unchanged schedule().
--   publishChoice     — what the author chose in "When should it go out?":
--     NONE            nothing chosen (default). An approval never publishes it.
--     PICK            a date and time, held in "proposedLocalTime".
--     AFTER_APPROVAL  "Right after approval": no time; it goes out when it is
--                     approved, and only by an approver who may also schedule.
--   "Best time automatically" is not a value: choosing it stores its time as
--   PICK.
--
-- EVERY EXISTING ROW SATISFIES BOTH CHECKS. The time column is added in this
-- same transaction, so no row can hold a time: every row is ('NONE', NULL).
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. Its Prisma client selects only the
-- columns it knows, and its inserts omit these, which default to NULL and
-- 'NONE'.
--
-- LOCKING. A nullable column, and a NOT NULL column with a constant default,
-- change metadata only (PostgreSQL 11+). The CHECKs are validated by a scan
-- under the ACCESS EXCLUSIVE lock the transaction already holds. A five-second
-- lock timeout means this migration never queues every request behind a long
-- transaction: it gives up, rolls back completely, and is deployed again
-- (OPERATIONS §6.13).
--
-- FORWARD-ONLY (OPERATIONS §6): there is no down script.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "content_item"
  ADD COLUMN "proposedLocalTime" TEXT;

CREATE TYPE "PublishChoice" AS ENUM ('NONE', 'PICK', 'AFTER_APPROVAL');

ALTER TABLE "content_item"
  ADD COLUMN "publishChoice" "PublishChoice" NOT NULL DEFAULT 'NONE';

-- The same wall-clock shape as a calendar slot's, or nothing.
ALTER TABLE "content_item"
  ADD CONSTRAINT "content_item_proposed_local_time_shape"
  CHECK (
    "proposedLocalTime" IS NULL
    OR "proposedLocalTime" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'
  );

-- A time is stored exactly when a time was picked.
ALTER TABLE "content_item"
  ADD CONSTRAINT "content_item_publish_choice_time"
  CHECK (("publishChoice" = 'PICK') = ("proposedLocalTime" IS NOT NULL));

-- PROVE IT: RLS still enabled and forced on "content_item".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname = 'content_item'
       AND relnamespace = 'public'::regnamespace
       AND relkind = 'r'
       AND relrowsecurity
       AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'publish time: RLS not enabled and forced on content_item';
  END IF;
END
$$;

COMMIT;
