-- Prototype v90 Phase 2C, item 1 (D9): the brand's "Use Brand Brain" switch in
-- Settings → AI.
--
-- SCHEMA ONLY, ADDITIVE. One column on "brand" with a constant default, so
-- PostgreSQL adds it without rewriting the table. No row is updated: every
-- existing brand keeps using Brand Brain for writing, exactly as it does today.
--
-- RLS AND GRANTS: unchanged. "brand" is already under its tenant policy and the
-- runtime roles' table-level grants cover a new column.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. That release never reads or writes
-- this column, and its brand inserts get the default. A rollback of the
-- application leaves the column in place and ignored: every brand is then
-- grounded as before, whatever its switch says.

ALTER TABLE "brand" ADD COLUMN "useBrandBrain" BOOLEAN NOT NULL DEFAULT true;
