-- Phase 6 final (D-277 §28, D-281): notes about ASSETS, an optional DUE date and
-- a simple IMPORTANCE flag on a conversation.
--
-- Nothing here is a task system: no status beyond open/resolved, no priority
-- scale, no dependencies. `note_thread` already has ENABLE + FORCE ROW LEVEL
-- SECURITY and its tenant_isolation policy; the new columns are covered by it.

-- 1. The Asset subject. `ADD VALUE` cannot be USED in the transaction that adds
-- it, so the CHECK below compares the column as TEXT rather than naming the new
-- enum value.
ALTER TYPE "NoteSubjectType" ADD VALUE IF NOT EXISTS 'ASSET';

CREATE TYPE "NoteImportance" AS ENUM ('NORMAL', 'IMPORTANT');

ALTER TABLE "note_thread" ADD COLUMN "assetId" UUID;
ALTER TABLE "note_thread" ADD COLUMN "dueAt" TIMESTAMPTZ(6);
ALTER TABLE "note_thread" ADD COLUMN "importance" "NoteImportance" NOT NULL DEFAULT 'NORMAL';

-- Exactly the right subject column is set for the subject type — now four.
ALTER TABLE "note_thread" DROP CONSTRAINT "note_thread_subject_exactly_one";
ALTER TABLE "note_thread"
  ADD CONSTRAINT "note_thread_subject_exactly_one"
  CHECK (
    ("subjectType"::text = 'CONTENT_ITEM' AND "contentItemId" IS NOT NULL AND "campaignId" IS NULL AND "assetId" IS NULL)
    OR ("subjectType"::text = 'CAMPAIGN' AND "campaignId" IS NOT NULL AND "contentItemId" IS NULL AND "assetId" IS NULL)
    OR ("subjectType"::text = 'BRAND' AND "contentItemId" IS NULL AND "campaignId" IS NULL AND "assetId" IS NULL)
    OR ("subjectType"::text = 'ASSET' AND "assetId" IS NOT NULL AND "contentItemId" IS NULL AND "campaignId" IS NULL)
  );

-- COMPOSITE, like every tenant reference (D-99): an asset of another workspace
-- cannot be named, whatever the id.
ALTER TABLE "note_thread"
  ADD CONSTRAINT "note_thread_asset_fkey"
  FOREIGN KEY ("workspaceId", "assetId") REFERENCES "asset"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE INDEX "note_thread_workspaceId_assetId_idx" ON "note_thread" ("workspaceId", "assetId");

-- 2. THE BRAND OF AN ASSET CONVERSATION. The foreign key proves the workspace;
-- it cannot prove the brand, because a workspace-shared asset has none. The
-- rule the service applies is enforced here too: the thread's brand is the
-- asset's own brand, or the asset is shared. The same shape as
-- `brand_canonical_asset_scope` (D-193), and like it NOT `SECURITY DEFINER`,
-- so RLS applies to the lookup.
CREATE OR REPLACE FUNCTION note_thread_asset_is_own_or_shared()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."assetId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "asset" a
    WHERE a."workspaceId" = NEW."workspaceId"
      AND a."id" = NEW."assetId"
      AND (a."brandId" IS NULL OR a."brandId" = NEW."brandId")
  ) THEN
    RAISE EXCEPTION 'a note about an asset must be in that asset''s brand, or about a shared asset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER note_thread_asset_scope
  BEFORE INSERT OR UPDATE OF "assetId", "brandId" ON "note_thread"
  FOR EACH ROW EXECUTE FUNCTION note_thread_asset_is_own_or_shared();

-- REFUSE TO COMMIT A HALF-APPLIED VERSION (the F-80 precedent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'note_thread_asset_scope' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'the note-thread asset scope trigger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'note_thread' AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'note_thread must keep FORCE ROW LEVEL SECURITY';
  END IF;
END $$;
