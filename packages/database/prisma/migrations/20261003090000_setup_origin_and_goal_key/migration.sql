-- Prototype v94 Phase 2B-1, G8 / C6 (D-335): what setup recorded, said so.
--
-- SCHEMA ONLY, ADDITIVE. One new value on the "BrandKnowledgeOrigin" enum and
-- one NULLABLE column on "brand" with a CHECK. Nothing is backfilled and no row
-- is inserted, updated or deleted, so a freshly migrated EMPTY database stays
-- empty.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. `ADD VALUE` appends to the enum
-- without rewriting a row or blocking a read; no existing row can hold the new
-- value, and only the new release writes it. The previous release neither
-- reads nor writes "primaryGoalKey"; every existing brand gets NULL, which the
-- new release reads as "no goal key — match the goal's title", exactly what it
-- does today. The CHECK holds for every existing row (NULL passes it), so it
-- validates instantly.
--
-- A ROLLBACK OF THE APPLICATION after the new release has written a SETUP row
-- is the one case the previous release would meet the value: its precedence
-- table does not know it. The rollback path is therefore a forward migration
-- that rewrites SETUP rows to DOCUMENT (the rank SETUP shares), never a replay
-- or an edit of this file. PostgreSQL cannot drop an enum value in place.

ALTER TYPE "BrandKnowledgeOrigin" ADD VALUE IF NOT EXISTS 'SETUP';

ALTER TABLE "brand" ADD COLUMN "primaryGoalKey" TEXT;

-- A goal key is one of the wizard's goal identifiers (upper-case words), never
-- free text: free text belongs in the goal's knowledge item, which is versioned.
ALTER TABLE "brand"
  ADD CONSTRAINT "brand_primary_goal_key_shape"
  CHECK ("primaryGoalKey" IS NULL OR "primaryGoalKey" ~ '^[A-Z][A-Z_]{1,39}$');
