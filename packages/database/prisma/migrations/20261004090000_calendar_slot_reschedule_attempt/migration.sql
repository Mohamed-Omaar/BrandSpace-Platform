-- PR #47 review item 13: the scheduling quota key counts genuine reschedules.
--
-- SCHEMA ONLY, ADDITIVE. One NOT NULL integer with a constant default on
-- "calendar_slot", and a CHECK that it is never negative. Nothing is backfilled
-- beyond the constant default and no row is inserted, updated or deleted, so a
-- freshly migrated EMPTY database stays empty.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. A constant default is stored in the
-- catalogue, so adding the column does not rewrite the table or hold a long
-- lock. The previous release neither reads nor writes the column; a slot it
-- inserts gets 0, which is exactly the attempt a first scheduling is. Every
-- existing row reads 0, and 0 derives the same quota key the previous release
-- stored, so an in-flight retry across the deploy stays idempotent.
--
-- ROLLBACK is by a forward migration (drop the column), never by replaying or
-- editing this file.

ALTER TABLE "calendar_slot" ADD COLUMN "rescheduleAttempt" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "calendar_slot"
  ADD CONSTRAINT "calendar_slot_reschedule_attempt_non_negative"
  CHECK ("rescheduleAttempt" >= 0);
