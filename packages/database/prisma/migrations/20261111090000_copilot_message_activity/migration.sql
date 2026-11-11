-- PR A (smart Copilot, D-604). SQL approved by the owner on <pending>.
--
-- SCHEMA ONLY, ADDITIVE. One NULLABLE column on "copilot_message"; nothing is
-- backfilled and every existing row keeps NULL. No RLS change: the table keeps
-- its existing tenant_isolation / platform_access policies (FORCE RLS), which
-- cover every column of the row.
--
-- WHAT IT HOLDS. For an assistant answer, what the Copilot read and did on the
-- way ("worked on": tool keys and their outcome, the ids of the drafts and
-- image jobs it made); for a person's message, the ids of the images they sent
-- with it. Ids, keys and statuses only — never customer text, never a tool's
-- raw result. Purged with the row, on the conversation's own retention.
--
-- ROLLBACK: a previous release ignores the column; dropping it loses only the
-- "worked on" lines of past answers.

ALTER TABLE "copilot_message" ADD COLUMN "activity" JSONB;
