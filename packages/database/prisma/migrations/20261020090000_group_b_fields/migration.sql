-- PR E (interaction parity, Group B, D-496) — three columns for three rows.
--
-- SCHEMA ONLY, ADDITIVE. One column and one CHECK on "campaign", one column on
-- "brand", one column on "insight", in one transaction. No row is inserted,
-- updated or rewritten, and RLS, its policies and grants are untouched: each
-- column belongs to a row the tenant policies already guard.
--
--   campaign.plannedPostCount — Campaigns 1, the form's "Number of posts":
--                               the card's "Published n / total" total. NULL
--                               means not set; the total is then the posts
--                               filed, as before.
--   brand.aiDraftsToReview    — Settings 3, "AI drafts go to review". Existing
--                               brands are OFF (this default); a brand created
--                               after this release starts ON, written by brand
--                               creation, never by a default (owner, Q3).
--   insight.snoozedUntil      — Home 4, "Not now" on a noticed insight: hidden
--                               until then. The status enum is unchanged.
--
-- EVERY EXISTING ROW SATISFIES THE CHECK: the column is added in this same
-- transaction, so every row is NULL.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. Its Prisma client selects only the
-- columns it knows, and its inserts omit these, which default to NULL, false
-- and NULL.
--
-- LOCKING. Nullable columns, and a NOT NULL column with a constant default,
-- change metadata only (PostgreSQL 11+). The CHECK is validated by a scan under
-- the ACCESS EXCLUSIVE lock the transaction already holds. A five-second lock
-- timeout means this migration never queues every request behind a long
-- transaction: it gives up, rolls back completely, and is deployed again
-- (OPERATIONS §6.13).
--
-- FORWARD-ONLY (OPERATIONS §6): there is no down script.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE "campaign"
  ADD COLUMN "plannedPostCount" INTEGER;

ALTER TABLE "campaign"
  ADD CONSTRAINT "campaign_planned_post_count_positive"
  CHECK ("plannedPostCount" IS NULL OR "plannedPostCount" > 0);

ALTER TABLE "brand"
  ADD COLUMN "aiDraftsToReview" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "insight"
  ADD COLUMN "snoozedUntil" TIMESTAMPTZ(3);

-- PROVE IT: RLS still enabled and forced on all three tables.
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(name, ', ') INTO missing
    FROM unnest(ARRAY['campaign', 'brand', 'insight']) AS name
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class
      WHERE relname = name
        AND relnamespace = 'public'::regnamespace
        AND relkind = 'r'
        AND relrowsecurity
        AND relforcerowsecurity
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'group B fields: RLS not enabled and forced on %', missing;
  END IF;
END
$$;

COMMIT;
