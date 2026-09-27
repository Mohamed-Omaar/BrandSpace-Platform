-- Prototype v90 Phase 2B-2, item 9 (D-332 follow-up, owner's Option 1):
-- a FAILED slot no longer counts as the post's live slot, so a post that
-- failed with nothing published can be scheduled again as a NEW slot while the
-- old one stays, FAILED, as history. Approved by the owner as M6.
--
-- SCHEMA ONLY. The partial unique index `calendar_slot_one_live_per_item`
-- (20260915120000_phase_5b_2_content_calendar) allowed one slot per post whose
-- status was not CANCELLED; it now allows one whose status is neither
-- CANCELLED nor FAILED. No row changes.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. The new predicate is strictly
-- looser, and the previous release never creates a second slot beside a
-- FAILED one (its own check counts FAILED as live), so nothing it does can
-- violate either index. DROP and CREATE run in one transaction, so no moment
-- exists without the rule; the index build takes a SHARE lock on
-- "calendar_slot" for as long as it runs (a small table: one row per
-- scheduled post).
--
-- FORWARD-ONLY (docs/OPERATIONS.md §6.3). Once a post has a FAILED slot and a
-- newer one, the stricter index cannot be recreated; rolling the application
-- back is safe (the old code refuses to schedule such a post again, and reads
-- work), but the index is corrected forward, never by replaying this file.

BEGIN;

DROP INDEX "calendar_slot_one_live_per_item";

CREATE UNIQUE INDEX "calendar_slot_one_live_per_item"
  ON "calendar_slot" ("workspaceId", "contentItemId")
  WHERE "status" NOT IN ('CANCELLED', 'FAILED');

COMMIT;
