-- PHASE 8 — PRODUCT COMPLETION
--
-- Two changes that have nothing to do with each other except that they are both
-- what "the product is whole" means, and both are schema:
--
--   1. CANONICAL BRAND IDENTITY ASSETS (D-193). A brand names which asset in the
--      ONE library is its logo. A reference, not a copy.
--   2. NO PRODUCT-WIDE COUNTRY ASSUMPTION (D-194). The Saudi defaults come off
--      the columns. Nothing stored changes.
--
-- ONE EXPLICIT TRANSACTION (D-113). Prisma wraps a migration only when it feels
-- like it; this file says so itself, so either all of it lands or none does.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. CANONICAL IDENTITY ASSETS
-- ---------------------------------------------------------------------------

ALTER TABLE "brand" ADD COLUMN "primaryLogoAssetId"   UUID;
ALTER TABLE "brand" ADD COLUMN "secondaryLogoAssetId" UUID;

-- COMPOSITE, ON (workspaceId, id) (D-112). A single-column key to `asset(id)`
-- would let a brand name an asset in ANOTHER WORKSPACE and the database would
-- accept it: the id is a uuid and uuids are global. With the tenant key in the
-- constraint there is nowhere for such a reference to point.
--
-- `ON DELETE SET NULL ("<column>")` NAMES THE COLUMN (D-114). A bare SET NULL on
-- a composite key nulls EVERY referencing column — including `workspaceId`,
-- which is NOT NULL, so deleting a referenced asset would not corrupt the tenant
-- key, it would FAIL. The column list confines the nulling to the reference.
ALTER TABLE "brand"
  ADD CONSTRAINT "brand_primary_logo_fkey"
  FOREIGN KEY ("workspaceId", "primaryLogoAssetId")
  REFERENCES "asset"("workspaceId", "id")
  ON DELETE SET NULL ("primaryLogoAssetId") ON UPDATE NO ACTION;

ALTER TABLE "brand"
  ADD CONSTRAINT "brand_secondary_logo_fkey"
  FOREIGN KEY ("workspaceId", "secondaryLogoAssetId")
  REFERENCES "asset"("workspaceId", "id")
  ON DELETE SET NULL ("secondaryLogoAssetId") ON UPDATE NO ACTION;

CREATE INDEX "brand_workspaceId_primaryLogoAssetId_idx"
  ON "brand" ("workspaceId", "primaryLogoAssetId");
CREATE INDEX "brand_workspaceId_secondaryLogoAssetId_idx"
  ON "brand" ("workspaceId", "secondaryLogoAssetId");

-- THE RULE A FOREIGN KEY CANNOT EXPRESS.
--
-- The composite key proves the asset is in the same WORKSPACE. It says nothing
-- about which BRAND the asset belongs to, and "brand A's logo is brand B's
-- private artwork" is exactly the cross-brand leak `BrandScope` exists to
-- prevent — a member who may see only brand A would be shown brand B's file
-- through A's profile, with the service layer none the wiser.
--
-- ADMISSIBLE: the brand's OWN asset, or a workspace-SHARED one (`brandId IS
-- NULL`) — the logo pack every brand draws on. Nothing else.
--
-- A TRIGGER RATHER THAN A CHECK, because the answer lives in another row and a
-- CHECK cannot read one. `SECURITY DEFINER` is deliberately NOT used: the
-- function runs as the caller, so RLS still applies to the lookup exactly as it
-- would to any other statement in the transaction.
CREATE OR REPLACE FUNCTION brand_canonical_asset_is_own_or_shared()
RETURNS TRIGGER AS $$
DECLARE
  offending UUID;
BEGIN
  FOREACH offending IN ARRAY ARRAY[NEW."primaryLogoAssetId", NEW."secondaryLogoAssetId"] LOOP
    IF offending IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM "asset" a
        WHERE a."workspaceId" = NEW."workspaceId"
          AND a."id" = offending
          AND (a."brandId" IS NULL OR a."brandId" = NEW."id")
      ) THEN
        RAISE EXCEPTION
          'a canonical identity asset must belong to this brand or be workspace-shared'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER brand_canonical_asset_scope
  BEFORE INSERT OR UPDATE OF "primaryLogoAssetId", "secondaryLogoAssetId" ON "brand"
  FOR EACH ROW EXECUTE FUNCTION brand_canonical_asset_is_own_or_shared();

-- ---------------------------------------------------------------------------
-- 2. THE SAUDI DEFAULTS COME OFF (D-194)
-- ---------------------------------------------------------------------------
--
-- DROP DEFAULT, NOT UPDATE. A default decides what a row gets when nobody says;
-- it has no effect on rows that already exist. Every workspace keeps the
-- country, locale, timezone and currency it has — including the ones that
-- genuinely are `SA`/`AR`/`Asia/Riyadh`/`SAR`, which are now stored choices
-- rather than an assumption nobody made.
--
-- The columns stay NOT NULL. Creation paths must supply them, and the
-- TypeScript signature makes that a compile error rather than a runtime one.
ALTER TABLE "workspace" ALTER COLUMN "country"       DROP DEFAULT;
ALTER TABLE "workspace" ALTER COLUMN "defaultLocale" DROP DEFAULT;
ALTER TABLE "workspace" ALTER COLUMN "timezone"      DROP DEFAULT;
ALTER TABLE "workspace" ALTER COLUMN "currency"      DROP DEFAULT;
ALTER TABLE "user"      ALTER COLUMN "timezone"      DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- REFUSE TO COMMIT A HALF-APPLIED VERSION
-- ---------------------------------------------------------------------------
--
-- The F-80/F-83 precedent: a migration that can silently do nothing is worse
-- than one that fails. Each of these is a property the rest of this phase
-- ASSUMES, so the assumption is checked here rather than discovered later.
DO $$
BEGIN
  -- The column-scoped SET NULL really is column-scoped, and does not name the
  -- tenant key. `confdelsetcols` is the catalogue's own record of the list.
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = ANY (c.confdelsetcols)
    WHERE c.conname IN ('brand_primary_logo_fkey', 'brand_secondary_logo_fkey')
      AND a.attname = 'workspaceId'
  ) THEN
    RAISE EXCEPTION 'a canonical logo key would null the tenant column';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname IN ('brand_primary_logo_fkey', 'brand_secondary_logo_fkey')
      AND COALESCE(array_length(c.confdelsetcols, 1), 0) <> 1
  ) THEN
    RAISE EXCEPTION 'a canonical logo key has no single-column SET NULL list';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'brand_canonical_asset_scope' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'the canonical-asset scope trigger is missing';
  END IF;

  -- RLS is untouched by this migration and must still be on. A new column on a
  -- table whose protection had been lifted is the shape of a silent regression.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'brand' AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'row-level security is not ENABLED and FORCED on brand';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_attrdef d
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE (c.relname = 'workspace' AND a.attname IN ('country', 'defaultLocale', 'timezone', 'currency'))
       OR (c.relname = 'user' AND a.attname = 'timezone')
  ) THEN
    RAISE EXCEPTION 'a country, locale, timezone or currency default survived';
  END IF;
END
$$;

COMMIT;
