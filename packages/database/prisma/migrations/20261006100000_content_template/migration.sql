-- Prototype v90 Phase 2B-2, E4 / B2: a brand's reusable post templates.
--
-- SCHEMA ONLY, ADDITIVE. One new tenant-owned table with ENABLE + FORCE RLS,
-- the same `tenant_isolation` / `platform_access` policies and grants as every
-- tenant table, a composite foreign key to the brand (so a template can never
-- name another workspace's brand), two PARTIAL unique indexes and bounds.
-- No row is inserted, updated or deleted.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. That release never reads or writes
-- this table.
--
-- ROLLBACK is by a forward migration (drop the table), never by replaying or
-- editing this file.

CREATE TABLE "content_template" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" "ContentType" NOT NULL DEFAULT 'POST',
    "platformKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "body" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstComment" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "content_template_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "content_template_workspaceId_brandId_idx" ON "content_template"("workspaceId", "brandId");

ALTER TABLE "content_template" ADD CONSTRAINT "content_template_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite, so the brand is reached only inside its own workspace.
ALTER TABLE "content_template" ADD CONSTRAINT "content_template_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One live name per brand, and ONE DEFAULT per brand. Partial on
-- `deletedAt IS NULL`, so a deleted template never blocks its name or the
-- default slot. Prisma cannot model a WHERE clause on a unique index, so these
-- live here and `prisma migrate diff` does not see them.
CREATE UNIQUE INDEX "content_template_live_name_per_brand"
  ON "content_template" ("workspaceId", "brandId", lower("name"))
  WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "content_template_one_default_per_brand"
  ON "content_template" ("workspaceId", "brandId")
  WHERE "isDefault" AND "deletedAt" IS NULL;

-- Bounds the service enforces first; the database refuses anything past them.
ALTER TABLE "content_template"
  ADD CONSTRAINT "content_template_name_bounded"
  CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
  ADD CONSTRAINT "content_template_body_bounded"
  CHECK ("body" IS NULL OR char_length("body") <= 5000),
  ADD CONSTRAINT "content_template_first_comment_bounded"
  CHECK ("firstComment" IS NULL OR char_length("firstComment") <= 2200),
  ADD CONSTRAINT "content_template_lists_bounded"
  CHECK (coalesce(cardinality("platformKeys"), 0) <= 20 AND coalesce(cardinality("hashtags"), 0) <= 60),
  ADD CONSTRAINT "content_template_version_positive"
  CHECK ("version" >= 1);

ALTER TABLE "content_template" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "content_template" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "content_template"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
CREATE POLICY platform_access ON "content_template"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "content_template" TO brandspace_app, brandspace_platform;
