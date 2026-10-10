-- BATCH 7 PR C (owner answer, Option B) — the post's publish choice.
--
-- ADDITIVE. One enum type, one NOT NULL column with a constant default, and one
-- CHECK on "content_item". Every existing post gets 'NONE' and behaves exactly
-- as before. RLS, its policies and grants are untouched.
--
-- ONE GUARDED UPDATE, for rows that cannot exist in a released database: a
-- post that already holds a "proposedLocalTime" (the column of the migration
-- just before this one, released together with it) is marked PICK, so the
-- CHECK below holds for it. On a database where that column is still all NULL
-- the update touches no row.
--
-- D-112's discipline, as `20261013090000_brand_scope_not_null` does it: the
-- migrator is NOBYPASSRLS, so under FORCE it would see no row to update while
-- the CHECK still validates every row. FORCE is lifted for this transaction
-- only (ALTER TABLE holds ACCESS EXCLUSIVE until COMMIT, so no other session
-- can observe it), restored, and proven before COMMIT. A failure anywhere rolls
-- every step back, the lifted FORCE included.
--
--   publishChoice — what the author chose in the Studio's "When should it go
--                   out?":
--     NONE            nothing chosen. An approval never publishes such a post.
--     PICK            a date and time, held in "proposedLocalTime". Scheduled
--                     by the Schedule press or "Approve & schedule".
--     AFTER_APPROVAL  "Right after approval": no time stored; the post goes
--                     out when it is approved, and only when the approver may
--                     also schedule.
--   "Best time automatically" is not a value: it is shown only with real data,
--   and choosing it stores the time it picked, as PICK.
--
-- THE CHECK ties the two columns together: a time is stored exactly when the
-- choice is PICK. Every existing row is ('NONE', NULL), which satisfies it.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. Its Prisma client selects only the
-- columns it knows, and its inserts omit this one, which defaults to 'NONE'.
--
-- LOCKING. A NOT NULL column with a constant default changes metadata only
-- (PostgreSQL 11+). The CHECK is validated by one scan under the ACCESS
-- EXCLUSIVE lock the transaction already holds, bounded by a five-second lock
-- timeout (OPERATIONS §6.13).
--
-- FORWARD-ONLY (OPERATIONS §6): there is no down script.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. LIFT FORCE, FOR THIS TRANSACTION ONLY.
ALTER TABLE "content_item" NO FORCE ROW LEVEL SECURITY;

-- 2. THE TYPE AND THE COLUMN (Prisma's `@default(NONE)`).
CREATE TYPE "PublishChoice" AS ENUM ('NONE', 'PICK', 'AFTER_APPROVAL');

ALTER TABLE "content_item"
  ADD COLUMN "publishChoice" "PublishChoice" NOT NULL DEFAULT 'NONE';

-- 3. A POST THAT ALREADY HOLDS A TIME PICKED IT. `updatedAt` is left alone.
UPDATE "content_item"
  SET "publishChoice" = 'PICK'
  WHERE "proposedLocalTime" IS NOT NULL;

-- 4. A time is stored exactly when a time was picked.
ALTER TABLE "content_item"
  ADD CONSTRAINT "content_item_publish_choice_time"
  CHECK (("publishChoice" = 'PICK') = ("proposedLocalTime" IS NOT NULL));

-- 5. RESTORE FORCE.
ALTER TABLE "content_item" FORCE ROW LEVEL SECURITY;

-- 6. PROVE IT: RLS enabled and forced on "content_item".
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
    RAISE EXCEPTION 'publish choice: RLS not forced on content_item';
  END IF;
END
$$;

COMMIT;
