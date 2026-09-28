-- PHASE 2C-2 (M3) — `brand_font`: the uploaded fonts a brand uses in Look & voice.
--
-- SCHEMA ONLY, ADDITIVE. One new tenant-owned table with ENABLE + FORCE RLS, the
-- same `tenant_isolation` / `platform_access` policies and grants as every tenant
-- table, composite foreign keys to the brand and to the asset (D-99), bounds, and
-- a trigger that keeps a font's file inside its own brand. No row is inserted:
-- no customer data, no sample data.
--
-- The font FILE stays an ordinary `asset` of kind FONT; this row is the logical
-- font (language, display name, archived or not). The previous release neither
-- reads nor writes this table. ROLLBACK is by a forward migration; an
-- application rollback leaves the table unused and the fonts as library assets.

CREATE TABLE "brand_font" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "language" "Locale" NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "brand_font_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "brand_font_workspaceId_brandId_assetId_key"
  ON "brand_font" ("workspaceId", "brandId", "assetId");
CREATE INDEX "brand_font_workspaceId_brandId_language_idx"
  ON "brand_font" ("workspaceId", "brandId", "language");

ALTER TABLE "brand_font" ADD CONSTRAINT "brand_font_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- COMPOSITE, so the brand and the asset are reached only inside their own workspace.
ALTER TABLE "brand_font" ADD CONSTRAINT "brand_font_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brand_font" ADD CONSTRAINT "brand_font_asset_fkey"
  FOREIGN KEY ("workspaceId", "assetId") REFERENCES "asset"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "brand_font"
  ADD CONSTRAINT "brand_font_display_name_bounded"
    CHECK (char_length(btrim("displayName")) BETWEEN 1 AND 80);

-- A FONT'S FILE IS A FONT OF ITS OWN BRAND. The foreign key proves the
-- workspace; it cannot prove the brand or the kind. Like the sibling scope
-- triggers (`note_thread_asset_scope`, `content_variant_cover_scope`) it is NOT
-- `SECURITY DEFINER`, so RLS applies to the lookup.
CREATE OR REPLACE FUNCTION brand_font_asset_is_own_font()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "asset" a
    WHERE a."workspaceId" = NEW."workspaceId"
      AND a."id" = NEW."assetId"
      AND a."brandId" = NEW."brandId"
      AND a."kind"::text = 'FONT'
  ) THEN
    RAISE EXCEPTION 'a brand font must be a FONT asset of that brand'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brand_font_asset_scope
  BEFORE INSERT OR UPDATE OF "assetId", "brandId" ON "brand_font"
  FOR EACH ROW EXECUTE FUNCTION brand_font_asset_is_own_font();

ALTER TABLE "brand_font" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_font" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "brand_font"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "brand_font"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_font" TO brandspace_app, brandspace_platform;

-- REFUSE TO COMMIT A HALF-APPLIED VERSION (the F-80 precedent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'brand_font_asset_scope' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'the brand-font asset scope trigger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'brand_font' AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'brand_font must keep FORCE ROW LEVEL SECURITY';
  END IF;
END $$;
