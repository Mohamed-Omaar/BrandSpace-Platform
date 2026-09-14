-- Phase 5B-1 — Asset Library.
--
-- docs/PRODUCT.md §5 module 13, docs/DATABASE.md §4.6 and §12, docs/SECURITY.md
-- §11, CLAUDE.md §2.1.
--
-- SIX TABLES, every one TENANT-OWNED. Five are additionally BRAND-SCOPED with a
-- NULLABLE brand, and the nullability is the product rule rather than a
-- convenience: docs/DATABASE.md §4.6 says "brandId (null = workspace-level)",
-- because a multi-brand company's logo pack, font files and legal boilerplate
-- genuinely belong to the workspace rather than to one of its brands.
--
-- TWO BOUNDARIES, ENFORCED INDEPENDENTLY, exactly as Phase 5A established:
--
--   1. The WORKSPACE boundary — RLS on `workspaceId`, ENABLE and FORCE, with a
--      tenant policy and a platform policy. Section 3.
--   2. The BRAND boundary — a composite foreign key `(workspaceId, brandId)`
--      referencing `brand(workspaceId, id)`.
--
-- A NULLABLE COLUMN DOES NOT WEAKEN THE SECOND, and it is worth stating why
-- rather than trusting it. PostgreSQL's default MATCH SIMPLE satisfies a
-- composite foreign key when ANY referencing column is NULL. So a
-- workspace-level row (brandId IS NULL) is exempt BY CONSTRUCTION, while every
-- brand-scoped row is still checked: a row naming another workspace's brand id
-- is refused by the database, not by a service that remembered to look. The
-- isolation suite asserts exactly that case, and asserts the NULL case too, so
-- the exemption is proven rather than assumed.
--
-- EVERY INTRA-LIBRARY FOREIGN KEY IS COMPOSITE, AND THAT IS NOT TIDINESS.
-- The first version of this migration used plain single-column keys for the
-- folder tree, the folder an asset sits in, and the asset a version, derivative,
-- session or job belongs to. The isolation suite asserted that a tenant could
-- not nest a folder under another tenant folder, AND IT GOT A CREATED ROW.
--
-- The reason is worth writing down, because it is not obvious and it defeats
-- the intuition that RLS covers everything: PostgreSQL performs referential
-- integrity checks WITH ROW-LEVEL SECURITY BYPASSED. A foreign key can
-- therefore reference a row the inserting role cannot read. Nothing is
-- disclosed directly — the tenant still cannot SELECT the parent — but the
-- insert SUCCEEDS only when the id names a real row, which turns any reference
-- column into an existence oracle over the whole platform. CLAUDE.md §2.1 lists
-- "infer" alongside read for exactly this shape of leak.
--
-- Pairing every reference with `workspaceId` collapses the oracle to "is this a
-- row in my OWN workspace", which discloses nothing, and makes the containment
-- a database fact rather than a service convention. It is the same lesson the
-- brand boundary taught in Phase 5A, applied one level down.
--
-- THE THIRD GRAIN IS NOT HERE, AND CANNOT BE. `Membership.brandScope` decides
-- which of a workspace's own brands a particular member may act on. Every row
-- involved is legitimately the tenant's, so no database policy can express it;
-- it is enforced inside the service boundary (F-74), and the isolation suite
-- uses a SECOND BRAND IN THE SAME WORKSPACE to prove it.

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'FONT');

-- CreateEnum
CREATE TYPE "AssetSource" AS ENUM ('UPLOAD', 'AI_GENERATED', 'IMPORTED');

-- CreateEnum
CREATE TYPE "AssetScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'PROCESSING_FAILED', 'QUARANTINED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AssetDerivativeKind" AS ENUM ('THUMBNAIL', 'PREVIEW');

-- CreateEnum
CREATE TYPE "AssetUploadSessionStatus" AS ENUM ('PENDING', 'COMPLETED', 'ABORTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AssetProcessingStage" AS ENUM ('QUEUED', 'SCANNING', 'INSPECTING', 'DERIVING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "asset_folder" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID,
    "parentFolderId" UUID,
    "name" TEXT NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "asset_folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID,
    "folderId" UUID,
    "name" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "storageKey" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "source" "AssetSource" NOT NULL DEFAULT 'UPLOAD',
    "aiRequestId" UUID,
    "license" TEXT,
    "rightsExpiryAt" TIMESTAMPTZ(6),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scanStatus" "AssetScanStatus" NOT NULL DEFAULT 'PENDING',
    "scanReason" TEXT,
    "scannedAt" TIMESTAMPTZ(6),
    "status" "AssetStatus" NOT NULL DEFAULT 'UPLOADING',
    "failureReason" TEXT,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "replacesAssetId" UUID,
    "uploadedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_version" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID,
    "assetId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "scanStatus" "AssetScanStatus" NOT NULL DEFAULT 'PENDING',
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_derivative" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "kind" "AssetDerivativeKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_derivative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_upload_session" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID,
    "folderId" UUID,
    "assetId" UUID,
    "declaredFileName" TEXT NOT NULL,
    "declaredMimeType" TEXT NOT NULL,
    "declaredSizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "AssetUploadSessionStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "asset_upload_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_processing_job" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID,
    "assetId" UUID NOT NULL,
    "stage" "AssetProcessingStage" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "failureReason" TEXT,
    "failureCode" TEXT,
    "derivativesCreated" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "nextAttemptAt" TIMESTAMPTZ(6),

    CONSTRAINT "asset_processing_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_folder_workspaceId_brandId_parentFolderId_name_idx" ON "asset_folder"("workspaceId", "brandId", "parentFolderId", "name");

-- CreateIndex
CREATE INDEX "asset_folder_workspaceId_parentFolderId_idx" ON "asset_folder"("workspaceId", "parentFolderId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_folder_workspaceId_id_key" ON "asset_folder"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "asset_workspaceId_brandId_status_idx" ON "asset"("workspaceId", "brandId", "status");

-- CreateIndex
CREATE INDEX "asset_workspaceId_kind_idx" ON "asset"("workspaceId", "kind");

-- CreateIndex
CREATE INDEX "asset_workspaceId_checksumSha256_idx" ON "asset"("workspaceId", "checksumSha256");

-- CreateIndex
CREATE INDEX "asset_workspaceId_brandId_folderId_createdAt_id_idx" ON "asset"("workspaceId", "brandId", "folderId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "asset_workspaceId_id_key" ON "asset"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "asset_version_workspaceId_assetId_versionNumber_idx" ON "asset_version"("workspaceId", "assetId", "versionNumber" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "asset_version_assetId_versionNumber_key" ON "asset_version"("assetId", "versionNumber");

-- CreateIndex
CREATE INDEX "asset_derivative_workspaceId_assetId_idx" ON "asset_derivative"("workspaceId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_derivative_assetId_kind_key" ON "asset_derivative"("assetId", "kind");

-- CreateIndex
CREATE INDEX "asset_upload_session_workspaceId_brandId_status_idx" ON "asset_upload_session"("workspaceId", "brandId", "status");

-- CreateIndex
CREATE INDEX "asset_upload_session_status_expiresAt_idx" ON "asset_upload_session"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "asset_upload_session_workspaceId_idempotencyKey_key" ON "asset_upload_session"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "asset_processing_job_workspaceId_assetId_queuedAt_idx" ON "asset_processing_job"("workspaceId", "assetId", "queuedAt" DESC);

-- CreateIndex
CREATE INDEX "asset_processing_job_stage_nextAttemptAt_idx" ON "asset_processing_job"("stage", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "asset_folder" ADD CONSTRAINT "asset_folder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_folder" ADD CONSTRAINT "asset_folder_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_folder" ADD CONSTRAINT "asset_folder_parent_fkey" FOREIGN KEY ("workspaceId", "parentFolderId") REFERENCES "asset_folder"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_folder_fkey" FOREIGN KEY ("workspaceId", "folderId") REFERENCES "asset_folder"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "asset_version" ADD CONSTRAINT "asset_version_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_version" ADD CONSTRAINT "asset_version_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_version" ADD CONSTRAINT "asset_version_asset_fkey" FOREIGN KEY ("workspaceId", "assetId") REFERENCES "asset"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "asset_derivative" ADD CONSTRAINT "asset_derivative_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_derivative" ADD CONSTRAINT "asset_derivative_asset_fkey" FOREIGN KEY ("workspaceId", "assetId") REFERENCES "asset"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "asset_upload_session" ADD CONSTRAINT "asset_upload_session_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_upload_session" ADD CONSTRAINT "asset_upload_session_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_upload_session" ADD CONSTRAINT "asset_upload_session_asset_fkey" FOREIGN KEY ("workspaceId", "assetId") REFERENCES "asset"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "asset_upload_session" ADD CONSTRAINT "asset_upload_session_folder_fkey" FOREIGN KEY ("workspaceId", "folderId") REFERENCES "asset_folder"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "asset_processing_job" ADD CONSTRAINT "asset_processing_job_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_processing_job" ADD CONSTRAINT "asset_processing_job_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_processing_job" ADD CONSTRAINT "asset_processing_job_asset_fkey" FOREIGN KEY ("workspaceId", "assetId") REFERENCES "asset"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 1. Duplicate protection that survives a delete.
--
-- docs/DATABASE.md §4.6 asks for `(workspaceId, checksumSha256)` "for dedupe".
-- A plain index detects nothing on its own, and a full UNIQUE constraint would
-- mean a customer who deleted a file could never upload it again — the row is
-- soft-deleted and would keep the checksum forever.
--
-- A PARTIAL unique index over the LIVE rows is the shape that answers both: two
-- live copies of the same bytes in one workspace are refused by the database
-- even when two requests race past the service's own check, and a deleted row
-- stops reserving its checksum the moment it is deleted. Prisma cannot express
-- a partial index, so it is created here in raw SQL ALONGSIDE the plain index
-- the model declares. The plain index stays because the model declares it and
-- because it is what serves a lookup that must also see deleted rows; the
-- partial one is the CONSTRAINT. `prisma migrate diff` does not model a partial
-- index, so it reports no drift against either — verified, not assumed, by the
-- drift check in tests/isolation.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "asset_live_checksum_unique"
  ON "asset" ("workspaceId", "checksumSha256")
  WHERE "deletedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Row-level security.
--
-- ENABLE *and* FORCE on every table. ENABLE alone leaves the table OWNER
-- exempt, and the owner is the migrator role — so a future migration running
-- ordinary DML would silently cross every tenant boundary.
-- ---------------------------------------------------------------------------
ALTER TABLE "asset_folder"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset_folder"          FORCE  ROW LEVEL SECURITY;
ALTER TABLE "asset"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset"                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE "asset_version"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset_version"         FORCE  ROW LEVEL SECURITY;
ALTER TABLE "asset_derivative"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset_derivative"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "asset_upload_session"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset_upload_session"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "asset_processing_job"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "asset_processing_job"  FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "asset_folder"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "asset"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "asset_version"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "asset_derivative"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "asset_upload_session"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "asset_processing_job"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "asset_folder"         TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "asset"                TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "asset_version"        TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "asset_derivative"     TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "asset_upload_session" TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "asset_processing_job" TO brandspace_platform USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. Privileges.
--
-- The blanket GRANT from the Phase 1 RLS migration does not reach tables
-- created afterwards, so each is granted explicitly. RLS then decides which
-- ROWS; the grant decides which VERBS.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "asset_folder"         TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "asset"                TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "asset_derivative"     TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "asset_upload_session" TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "asset_processing_job" TO brandspace_app, brandspace_platform;

-- ---------------------------------------------------------------------------
-- 4. The version history is APPEND-ONLY, in three separated layers — with ONE
--    column deliberately exempt.
--
-- The same construction `brand_knowledge_version` uses, and for a sharper
-- reason: a customer restoring version 2 must get exactly the file they
-- uploaded, and "exactly" is only true if nothing could have edited the row in
-- between.
--
--   Layer 1 — REVOKED PRIVILEGE. Neither application role holds DELETE, and
--             neither holds a table-wide UPDATE. The UPDATE grant is
--             COLUMN-LEVEL and names exactly one column.
--   Layer 2 — FORCE RLS WITH NO OWNER POLICY. The owner is not exempt and has
--             no policy admitting it, so even the migrator is refused.
--   Layer 3 — A TRIGGER. The one that still holds after a careless future
--             migration grants the privilege back, which is exactly what the
--             isolation suite does before asserting the refusal.
--
-- WHY `scanStatus` IS EXEMT, and why that is not a hole. The immutable facts
-- are WHICH BYTES this version is: its key, its checksum, its size, its
-- dimensions, its number. The scan verdict is not one of them — it is a fact
-- ABOUT those bytes, discovered afterwards by a scanner that necessarily runs
-- after the row exists. An append-only row with a column that must be written
-- later is a contradiction, and the first version of this migration contained
-- it: the processor could not record a clean verdict at all, which the
-- isolation suite found on its first run as `permission denied for table
-- asset_version`.
--
-- The resolution keeps immutability where it means something. PostgreSQL grants
-- UPDATE per column, so the roles can write `scanStatus` and NOTHING else, and
-- the trigger refuses an UPDATE that changes any other column even if a future
-- migration widened the grant. The bytes a version names still cannot be
-- rewritten by anyone.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON "asset_version" TO brandspace_app, brandspace_platform;
GRANT UPDATE ("scanStatus") ON "asset_version" TO brandspace_app, brandspace_platform;
REVOKE DELETE ON "asset_version" FROM brandspace_app;
REVOKE DELETE ON "asset_version" FROM brandspace_platform;

CREATE OR REPLACE FUNCTION app.refuse_asset_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'asset_version is append-only: DELETE is refused'
      USING ERRCODE = 'restrict_violation';
  END IF;

  /*
   * AN UPDATE IS PERMITTED ONLY WHERE `scanStatus` IS THE ONLY DIFFERENCE.
   *
   * Compared field by field rather than by rebuilding the row with the new
   * verdict and testing equality: the row-equality form quietly starts
   * permitting any column added later, because a new column is equal on both
   * sides until someone writes it. Naming the immutable fields means a future
   * column is NOT covered by accident, and the reviewer adding it has to
   * decide.
   */
  IF NEW."id"             IS DISTINCT FROM OLD."id"
  OR NEW."workspaceId"    IS DISTINCT FROM OLD."workspaceId"
  OR NEW."brandId"        IS DISTINCT FROM OLD."brandId"
  OR NEW."assetId"        IS DISTINCT FROM OLD."assetId"
  OR NEW."versionNumber"  IS DISTINCT FROM OLD."versionNumber"
  OR NEW."storageKey"     IS DISTINCT FROM OLD."storageKey"
  OR NEW."checksumSha256" IS DISTINCT FROM OLD."checksumSha256"
  OR NEW."mimeType"       IS DISTINCT FROM OLD."mimeType"
  OR NEW."sizeBytes"      IS DISTINCT FROM OLD."sizeBytes"
  OR NEW."width"          IS DISTINCT FROM OLD."width"
  OR NEW."height"         IS DISTINCT FROM OLD."height"
  OR NEW."durationMs"     IS DISTINCT FROM OLD."durationMs"
  OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
  OR NEW."createdAt"      IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'asset_version is append-only: only scanStatus may change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER asset_version_append_only
  BEFORE UPDATE OR DELETE ON "asset_version"
  FOR EACH ROW EXECUTE FUNCTION app.refuse_asset_version_mutation();

-- ---------------------------------------------------------------------------
-- 5. The Asset Library's operational policy becomes a TENANT-READABLE
--    projection.
--
-- The customer's own screen has to state what it may accept, how large a file
-- may be and how many versions it will keep, and the upload path has to ENFORCE
-- the same numbers. Phase 5A's mistake was restating them in the dashboard;
-- a restated setting is a second setting. `configuration_version` stays
-- platform-owned with every privilege revoked from the tenant role, and the
-- Configuration Service projects the `assets` domain here on activation.
--
-- WHAT IS PROJECTED. Operational policy only: accepted media types, size,
-- count, version and derivative ceilings, the upload-session window, the
-- download-grant window, scan settings and the retention window. No provider,
-- no model, no price, no credential — the storage VENDOR lives in
-- `integrations.storage`, which this CHECK does not admit.
-- ---------------------------------------------------------------------------
ALTER TABLE "entitlement_catalogue_snapshot"
  DROP CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains";

ALTER TABLE "entitlement_catalogue_snapshot"
  ADD CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains"
  CHECK ("domain" IN ('entitlements', 'plans', 'feature-flags', 'credits', 'brand-brain', 'assets'));
