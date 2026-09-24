-- Phase 6 final (D-277 §24, D-285): a Reel's COVER, durably.
--
-- A cover chosen in the composer must survive a reload, so it is a column and
-- not browser state. The smallest correct shape: one nullable reference from a
-- platform variant to one asset. `content_variant` already has ENABLE + FORCE
-- ROW LEVEL SECURITY and its tenant_isolation policy; the column is covered by
-- it.

ALTER TABLE "content_variant" ADD COLUMN "coverAssetId" UUID;

-- COMPOSITE, like every tenant reference (D-99): another workspace's asset
-- cannot be named whatever the id. Deleting the asset clears the cover and
-- nothing else.
ALTER TABLE "content_variant"
  ADD CONSTRAINT "content_variant_cover_fkey"
  FOREIGN KEY ("workspaceId", "coverAssetId") REFERENCES "asset"("workspaceId", "id")
  ON DELETE SET NULL ("coverAssetId") ON UPDATE NO ACTION;

CREATE INDEX "content_variant_workspaceId_coverAssetId_idx"
  ON "content_variant" ("workspaceId", "coverAssetId");

-- THE COVER'S BRAND. The foreign key proves the workspace; it cannot prove the
-- brand, because a workspace-shared asset has none. The service applies the
-- rule (the variant's own brand, or the shared shelf); this enforces it too.
-- The same shape as `note_thread_asset_scope` (D-281) and, like it, NOT
-- `SECURITY DEFINER`, so RLS applies to the lookup.
CREATE OR REPLACE FUNCTION content_variant_cover_is_own_or_shared()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."coverAssetId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "asset" a
    WHERE a."workspaceId" = NEW."workspaceId"
      AND a."id" = NEW."coverAssetId"
      AND (a."brandId" IS NULL OR a."brandId" = NEW."brandId")
  ) THEN
    RAISE EXCEPTION 'a cover must be an asset of the variant''s brand, or a shared asset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_variant_cover_scope
  BEFORE INSERT OR UPDATE OF "coverAssetId", "brandId" ON "content_variant"
  FOR EACH ROW EXECUTE FUNCTION content_variant_cover_is_own_or_shared();

-- REFUSE TO COMMIT A HALF-APPLIED VERSION (the F-80 precedent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'content_variant_cover_scope' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'the content-variant cover scope trigger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'content_variant' AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'content_variant must keep FORCE ROW LEVEL SECURITY';
  END IF;
END $$;
