-- ---------------------------------------------------------------------------
-- Phase 5B-2 — AI Content Studio (docs/PRODUCT.md §5 module 7,
-- docs/DATABASE.md §4.4 and §4.5, docs/ROADMAP.md Phase 5 scope item 3).
--
-- TWO TENANT-OWNED TABLES, both brand-scoped, and EVERY foreign key between
-- them composite with `workspaceId` (D-112). That rule is not inherited from
-- the Asset Library any more: F-80 and F-83 established it as the platform
-- rule, and `content_variant.contentItemId` is exactly the shape that was the
-- oracle in both — a child pointing at a tenant-owned parent by id alone.
--
-- PLUS THREE COLUMNS THE CUSTOMER CONTROLS, which are the two decisions the
-- owner approved for this phase:
--
--   workspace."arabicDialect"           D-115 — the dialect this workspace writes in
--   brand."arabicDialect"               D-115 — the brand's override
--   workspace."aiContentRetentionDays"  D-117 — the customer's retention control
--
-- All three are ADDITIVE and NULLABLE. Null is the configured default in every
-- case, so this migration changes no existing behaviour for any existing row.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The customer-controlled columns.
--
-- `arabicDialect` is TEXT, not an enum, and that is D-115 doing its job: the
-- supported dialects and the default live in the activated `content`
-- configuration domain, so adding Emirati or Maghrebi later is an operator
-- change rather than a migration. An enum would also have forced this file to
-- pick a first value, and the owner's decision says explicitly that no dialect
-- — Saudi least of all — is hard-coded as the default.
--
-- `aiContentRetentionDays` is NULL by default, which is D-116: retained while
-- the subscription is active. A positive value is a customer asking for
-- something shorter. Nothing here can reach an audit event, a credit
-- transaction or a billing record.
-- ---------------------------------------------------------------------------

ALTER TABLE "workspace" ADD COLUMN "arabicDialect" TEXT;
ALTER TABLE "workspace" ADD COLUMN "aiContentRetentionDays" INTEGER;
ALTER TABLE "brand"     ADD COLUMN "arabicDialect" TEXT;

-- A retention window a customer can set must still be a window. Zero would mean
-- "delete on write", which is not a retention policy but a broken feature, and
-- a negative number is nonsense the service should never be the only thing
-- refusing.
ALTER TABLE "workspace"
  ADD CONSTRAINT "workspace_ai_content_retention_days_positive"
  CHECK ("aiContentRetentionDays" IS NULL OR "aiContentRetentionDays" > 0);

-- ---------------------------------------------------------------------------
-- 2. Enums.
-- ---------------------------------------------------------------------------

CREATE TYPE "ContentType" AS ENUM ('POST', 'CAROUSEL', 'STORY', 'REEL', 'VIDEO', 'ARTICLE', 'THREAD');

CREATE TYPE "ContentStatus" AS ENUM (
  'DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED',
  'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED', 'ARCHIVED');

CREATE TYPE "ContentValidationState" AS ENUM ('UNVALIDATED', 'VALID', 'WARNINGS', 'INVALID');

CREATE TYPE "ContentOrigin" AS ENUM ('HUMAN', 'AI_GENERATED', 'AI_ASSISTED');

-- ---------------------------------------------------------------------------
-- 3. Tables.
-- ---------------------------------------------------------------------------

CREATE TABLE "content_item" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "contentType" "ContentType" NOT NULL DEFAULT 'POST',
    "primaryLocale" "Locale" NOT NULL DEFAULT 'AR',
    "pillar" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "origin" "ContentOrigin" NOT NULL DEFAULT 'HUMAN',
    "createdByUserId" UUID,
    "aiRequestId" UUID,
    "citations" JSONB,
    "insufficientKnowledge" BOOLEAN NOT NULL DEFAULT false,
    "arabicDialect" TEXT,
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "content_item_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "content_variant" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "contentItemId" UUID NOT NULL,
    "platformKey" TEXT NOT NULL,
    "locale" "Locale" NOT NULL,
    "body" TEXT,
    "bodyPurgedAt" TIMESTAMPTZ(6),
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linkUrl" TEXT,
    "firstComment" TEXT,
    "assetIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "platformOptions" JSONB,
    "validationState" "ContentValidationState" NOT NULL DEFAULT 'UNVALIDATED',
    "validationErrors" JSONB,
    "characterCount" INTEGER NOT NULL DEFAULT 0,
    "origin" "ContentOrigin" NOT NULL DEFAULT 'HUMAN',
    "aiRequestId" UUID,
    "arabicDialect" TEXT,
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "content_variant_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 4. Indexes.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "content_item_workspaceId_id_key" ON "content_item"("workspaceId", "id");
CREATE UNIQUE INDEX "content_item_workspaceId_idempotencyKey_key" ON "content_item"("workspaceId", "idempotencyKey");
CREATE INDEX "content_item_workspaceId_brandId_status_idx" ON "content_item"("workspaceId", "brandId", "status");
CREATE INDEX "content_item_workspaceId_brandId_updatedAt_idx" ON "content_item"("workspaceId", "brandId", "updatedAt" DESC);
CREATE INDEX "content_item_expiresAt_idx" ON "content_item"("expiresAt");

CREATE UNIQUE INDEX "content_variant_contentItemId_platformKey_locale_key" ON "content_variant"("contentItemId", "platformKey", "locale");
CREATE INDEX "content_variant_workspaceId_contentItemId_idx" ON "content_variant"("workspaceId", "contentItemId");
CREATE INDEX "content_variant_workspaceId_brandId_idx" ON "content_variant"("workspaceId", "brandId");
CREATE INDEX "content_variant_expiresAt_idx" ON "content_variant"("expiresAt");

-- ---------------------------------------------------------------------------
-- 5. Foreign keys — every one composite with `workspaceId` (D-112).
-- ---------------------------------------------------------------------------

ALTER TABLE "content_item" ADD CONSTRAINT "content_item_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "content_item" ADD CONSTRAINT "content_item_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "content_variant" ADD CONSTRAINT "content_variant_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "content_variant" ADD CONSTRAINT "content_variant_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "content_variant" ADD CONSTRAINT "content_variant_item_fkey"
  FOREIGN KEY ("workspaceId", "contentItemId") REFERENCES "content_item"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 6. Row-level security.
--
-- ENABLE *and* FORCE on both tables. ENABLE alone leaves the table OWNER
-- exempt, and the owner is the migrator role — so a future migration running
-- ordinary DML would silently cross every tenant boundary.
-- ---------------------------------------------------------------------------

ALTER TABLE "content_item"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "content_item"    FORCE  ROW LEVEL SECURITY;
ALTER TABLE "content_variant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "content_variant" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "content_item"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "content_variant"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "content_item"    TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "content_variant" TO brandspace_platform USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 7. Privileges — least privilege, as everywhere else.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON "content_item"    TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "content_variant" TO brandspace_app, brandspace_platform;

-- ---------------------------------------------------------------------------
-- 8. One live draft per idempotency key, and the reason it is not the unique
--    index above on its own.
--
-- `content_item_workspaceId_idempotencyKey_key` is a full UNIQUE index, so a
-- soft-deleted draft keeps its key for ever and the same generation can never
-- be replayed after a delete. That is the CORRECT direction here and the
-- opposite of the Asset Library's checksum case (D-100): a checksum identifies
-- BYTES, which a customer may legitimately upload again, while an idempotency
-- key identifies ONE REQUEST, which must never produce a second charge no
-- matter what happened to the first result. Re-running a generation is a new
-- request with a new key.
--
-- Recorded here rather than left implicit because the two indexes look alike
-- and the difference between them is a billing guarantee.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 9. Admit `content` to the tenant entitlement-catalogue projection.
--
-- The projection is what lets the CUSTOMER's own screens read an activated
-- configuration domain without the tenant role being able to read
-- `configuration_version` (F-71, D-109). The allowed-domain CHECK is a closed
-- list on purpose — projecting a domain makes it tenant-readable, which is a
-- decision and not a default — so adding one is a deliberate migration.
--
-- `content` earns it for the reason `assets` did: the composer has to know the
-- platform character limit BEFORE the caption is too long, the dialect picker
-- has to know which dialects exist (D-115), and the settings screen has to
-- state the retention floor it is enforcing (D-117). A dashboard that restated
-- any of those would be a second setting that drifts from the first.
--
-- It carries no provider, no model, no price and no credential.
-- ---------------------------------------------------------------------------

ALTER TABLE "entitlement_catalogue_snapshot"
  DROP CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains";

ALTER TABLE "entitlement_catalogue_snapshot"
  ADD CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains"
  CHECK ("domain" IN ('entitlements', 'plans', 'feature-flags', 'credits', 'brand-brain', 'assets', 'content'));

COMMIT;
