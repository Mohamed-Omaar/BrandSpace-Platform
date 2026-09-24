-- Phase 6 final (D-277 §37, D-280): the Copilot knows what the customer is looking at.
--
-- A conversation opened from a campaign, a content item or an insight records
-- WHICH one. Both columns or neither, and only the three kinds the orchestrator
-- admits. No foreign key: the subject is one of three tables, admitted by query
-- against the session's own brand when the session opens and re-read on every
-- turn. The table's existing FORCE RLS policy covers the new columns.

ALTER TABLE "copilot_session" ADD COLUMN "subjectType" TEXT;
ALTER TABLE "copilot_session" ADD COLUMN "subjectId" UUID;

ALTER TABLE "copilot_session" ADD CONSTRAINT "copilot_session_subject_check" CHECK (
  ("subjectType" IS NULL AND "subjectId" IS NULL)
  OR ("subjectType" IN ('CAMPAIGN', 'CONTENT_ITEM', 'INSIGHT') AND "subjectId" IS NOT NULL)
);
