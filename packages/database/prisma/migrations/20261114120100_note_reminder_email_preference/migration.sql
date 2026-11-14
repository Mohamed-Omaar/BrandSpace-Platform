-- PR D (D-608) — "Email me my note reminders": one person's own switch.
-- AMENDMENT TO THE PR D SQL, SENT FOR APPROVAL SEPARATELY; not applied anywhere.
--
-- The switch is one `notification_preference` row under its own category,
-- `email.note_reminders`, OFF unless the person turns it on (absence = off).
-- The table's CHECK lists the categories it accepts; this adds the one name.
-- No row, policy or grant changes: the existing RLS (this workspace only, and
-- the code names the person's own user id) already covers the new row.
-- FORWARD-ONLY. Every existing row satisfies the wider CHECK.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "notification_preference" DROP CONSTRAINT "notification_preference_category_known";
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_category_known"
  CHECK ("category" IN (
    'approvals', 'publishing', 'automations', 'brand_brain_reviews',
    'email.note_reminders'
  ));

COMMIT;
