-- PHASE 2C-4 (M6) — ONE LIVE SOURCE PER FILE, and a removed file can come back.
--
-- SCHEMA ONLY. No row is inserted, updated or deleted: no customer data, no
-- sample data, NO BACKFILL.
--
-- NOT ADDITIVE. This REPLACES an existing uniqueness rule. The unique index
-- `brand_source_document_workspaceId_brandId_checksum_key`
-- (20260913140000_phase_5_brand_brain) allowed one document per brand and
-- checksum across EVERY row, removed ones included, so a source removed with
-- Remove (a soft delete, `deletedAt`) could never be uploaded again: the
-- application's own duplicate check already looks at live rows only, and the
-- insert then failed on the index. The rule becomes a PARTIAL unique index on
-- the same key, `WHERE "deletedAt" IS NULL`:
--
--   - two LIVE documents with the same bytes in one brand stay impossible;
--   - a removed document no longer holds its checksum, so the same file can be
--     uploaded again as a new source;
--   - a FAILED document is live (`deletedAt IS NULL`) and DOES hold the slot:
--     uploading the same bytes again returns that FAILED row through the
--     application's existing duplicate path (docs/DECISIONS.md, Phase 2C-4).
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. The new predicate is strictly looser
-- and covers every row the previous release could create a duplicate of: that
-- release has no Remove, so it never soft-deletes a document, and its duplicate
-- check already filters `deletedAt IS NULL`. DROP and CREATE run in one
-- transaction, so no moment exists without the rule; the build takes a SHARE
-- lock on "brand_source_document" (one row per uploaded file) while it runs.
--
-- ROLLBACK. Rolling the APPLICATION back is safe: the old code reads and
-- writes live rows only. Re-creating the old, stricter index is possible only
-- while no brand holds a removed document and a live one with the same
-- checksum; once one does, the index is corrected forward, never by replaying
-- the old definition (docs/OPERATIONS.md §6.3).

BEGIN;

DROP INDEX "brand_source_document_workspaceId_brandId_checksum_key";

CREATE UNIQUE INDEX "brand_source_document_live_checksum_key"
  ON "brand_source_document" ("workspaceId", "brandId", "checksum")
  WHERE "deletedAt" IS NULL;

COMMIT;
