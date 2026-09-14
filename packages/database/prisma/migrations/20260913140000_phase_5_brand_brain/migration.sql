-- Phase 5 — Brand and Brand Brain.
--
-- docs/PRODUCT.md §6A, docs/DATABASE.md §4.1–4.2, D-63/D-64/D-65/D-78.
--
-- NINE TABLES, every one TENANT-OWNED and every one additionally BRAND-SCOPED.
-- Two boundaries, enforced independently:
--
--   1. The WORKSPACE boundary — RLS on `workspaceId`, as every tenant table
--      since Phase 1. Section 3 below.
--   2. The BRAND boundary — a composite foreign key `(workspaceId, brandId)`
--      referencing `brand(workspaceId, id)`. A row pointing at another
--      workspace's brand is refused by the database, not by a service that
--      remembered to check (docs/DATABASE.md §12).
--
-- The second is what makes cross-BRAND isolation provable. RLS alone would let
-- a workspace attach knowledge to a brand it does not own only if the brand id
-- leaked; the composite key means that even then the insert fails.

-- CreateEnum
CREATE TYPE "BrandStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BrandKnowledgeArea" AS ENUM ('IDENTITY', 'AUDIENCE', 'TONE_OF_VOICE', 'OFFERS', 'PROOF_POINTS', 'DO_DONT', 'COMPETITORS', 'GLOSSARY', 'STRATEGY', 'LEARNINGS');

-- CreateEnum
CREATE TYPE "BrandMemoryLayer" AS ENUM ('CANONICAL', 'STRATEGY', 'CONTENT', 'LEARNING');

-- CreateEnum
CREATE TYPE "BrandKnowledgeOrigin" AS ENUM ('HUMAN', 'DOCUMENT', 'AI_INFERRED');

-- CreateEnum
CREATE TYPE "BrandKnowledgeStatus" AS ENUM ('DRAFT', 'PROPOSED', 'ACTIVE', 'STALE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BrandSourceStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'READY', 'FAILED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "BrandIngestionStage" AS ENUM ('QUEUED', 'EXTRACTING', 'CHUNKING', 'EXTRACTING_FACTS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BrandCandidateStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EDITED_ACCEPTED', 'REJECTED', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "ai_request" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ai_usage_ledger" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "beta_cohort_membership" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "credit_grant" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "credit_reservation" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "usage_counter" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "usage_event" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "workspace_subscription" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "brand" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "description" TEXT,
    "websiteUrl" TEXT,
    "defaultLocale" "Locale" NOT NULL DEFAULT 'EN',
    "supportedLocales" "Locale"[] DEFAULT ARRAY[]::"Locale"[],
    "colorPalette" JSONB,
    "typography" JSONB,
    "voiceProfile" JSONB,
    "status" "BrandStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_knowledge_item" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "area" "BrandKnowledgeArea" NOT NULL,
    "memory" "BrandMemoryLayer" NOT NULL DEFAULT 'CANONICAL',
    "origin" "BrandKnowledgeOrigin" NOT NULL DEFAULT 'HUMAN',
    "status" "BrandKnowledgeStatus" NOT NULL DEFAULT 'DRAFT',
    "itemKey" TEXT NOT NULL,
    "title" JSONB NOT NULL,
    "body" JSONB NOT NULL,
    "confidenceMilli" INTEGER,
    "createdByUserId" UUID,
    "sourceDocumentId" UUID,
    "aiRequestId" UUID,
    "evidence" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "indexVector" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "indexModelKey" TEXT,
    "indexedAt" TIMESTAMPTZ(6),
    "lastReviewedAt" TIMESTAMPTZ(6),
    "reviewDueAt" TIMESTAMPTZ(6),
    "conflictsWithItemId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "brand_knowledge_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_knowledge_version" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "knowledgeItemId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "area" "BrandKnowledgeArea" NOT NULL,
    "memory" "BrandMemoryLayer" NOT NULL,
    "origin" "BrandKnowledgeOrigin" NOT NULL,
    "status" "BrandKnowledgeStatus" NOT NULL,
    "title" JSONB NOT NULL,
    "body" JSONB NOT NULL,
    "confidenceMilli" INTEGER,
    "evidence" JSONB,
    "changedByUserId" UUID,
    "changeReason" TEXT,
    "changeKind" TEXT NOT NULL,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_knowledge_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_source_document" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "BrandSourceStatus" NOT NULL DEFAULT 'UPLOADED',
    "failureMessage" TEXT,
    "pageCount" INTEGER,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "textLength" INTEGER NOT NULL DEFAULT 0,
    "targetArea" "BrandKnowledgeArea",
    "uploadedByUserId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "processedAt" TIMESTAMPTZ(6),
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "brand_source_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_source_chunk" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "sourceDocumentId" UUID NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "locator" TEXT,
    "indexVector" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "indexModelKey" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_source_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_knowledge_candidate" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "sourceDocumentId" UUID NOT NULL,
    "targetItemId" UUID,
    "area" "BrandKnowledgeArea" NOT NULL,
    "itemKey" TEXT NOT NULL,
    "extractedTitle" JSONB NOT NULL,
    "extractedBody" JSONB NOT NULL,
    "reviewedTitle" JSONB,
    "reviewedBody" JSONB,
    "confidenceMilli" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "BrandCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByUserId" UUID,
    "reviewedAt" TIMESTAMPTZ(6),
    "reviewReason" TEXT,
    "resultingVersion" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_knowledge_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_ingestion_job" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "sourceDocumentId" UUID NOT NULL,
    "stage" "BrandIngestionStage" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "failureMessage" TEXT,
    "failureCode" TEXT,
    "chunksCreated" INTEGER NOT NULL DEFAULT 0,
    "candidatesCreated" INTEGER NOT NULL DEFAULT 0,
    "aiRequestId" UUID,
    "queuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "nextAttemptAt" TIMESTAMPTZ(6),

    CONSTRAINT "brand_ingestion_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_brain_conversation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "area" "BrandKnowledgeArea",
    "title" TEXT,
    "startedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6),

    CONSTRAINT "brand_brain_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_brain_message" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "body" TEXT,
    "bodyPurgedAt" TIMESTAMPTZ(6),
    "citations" JSONB,
    "insufficientKnowledge" BOOLEAN NOT NULL DEFAULT false,
    "aiRequestId" UUID,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6),

    CONSTRAINT "brand_brain_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brand_workspaceId_status_idx" ON "brand"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "brand_workspaceId_id_key" ON "brand"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_workspaceId_slug_key" ON "brand"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "brand_knowledge_item_workspaceId_brandId_area_status_idx" ON "brand_knowledge_item"("workspaceId", "brandId", "area", "status");

-- CreateIndex
CREATE INDEX "brand_knowledge_item_workspaceId_brandId_status_memory_idx" ON "brand_knowledge_item"("workspaceId", "brandId", "status", "memory");

-- CreateIndex
CREATE INDEX "brand_knowledge_item_workspaceId_brandId_reviewDueAt_idx" ON "brand_knowledge_item"("workspaceId", "brandId", "reviewDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "brand_knowledge_item_workspaceId_brandId_area_itemKey_key" ON "brand_knowledge_item"("workspaceId", "brandId", "area", "itemKey");

-- CreateIndex
CREATE INDEX "brand_knowledge_version_workspaceId_brandId_recordedAt_idx" ON "brand_knowledge_version"("workspaceId", "brandId", "recordedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "brand_knowledge_version_knowledgeItemId_version_key" ON "brand_knowledge_version"("knowledgeItemId", "version");

-- CreateIndex
CREATE INDEX "brand_source_document_workspaceId_brandId_status_idx" ON "brand_source_document"("workspaceId", "brandId", "status");

-- CreateIndex
CREATE INDEX "brand_source_document_workspaceId_brandId_createdAt_idx" ON "brand_source_document"("workspaceId", "brandId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "brand_source_document_workspaceId_brandId_checksum_key" ON "brand_source_document"("workspaceId", "brandId", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "brand_source_document_workspaceId_idempotencyKey_key" ON "brand_source_document"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "brand_source_chunk_workspaceId_brandId_idx" ON "brand_source_chunk"("workspaceId", "brandId");

-- CreateIndex
CREATE UNIQUE INDEX "brand_source_chunk_sourceDocumentId_chunkIndex_key" ON "brand_source_chunk"("sourceDocumentId", "chunkIndex");

-- CreateIndex
CREATE INDEX "brand_knowledge_candidate_workspaceId_brandId_status_idx" ON "brand_knowledge_candidate"("workspaceId", "brandId", "status");

-- CreateIndex
CREATE INDEX "brand_knowledge_candidate_workspaceId_brandId_area_status_idx" ON "brand_knowledge_candidate"("workspaceId", "brandId", "area", "status");

-- CreateIndex
CREATE INDEX "brand_knowledge_candidate_sourceDocumentId_status_idx" ON "brand_knowledge_candidate"("sourceDocumentId", "status");

-- CreateIndex
CREATE INDEX "brand_ingestion_job_workspaceId_brandId_stage_idx" ON "brand_ingestion_job"("workspaceId", "brandId", "stage");

-- CreateIndex
CREATE INDEX "brand_ingestion_job_stage_nextAttemptAt_idx" ON "brand_ingestion_job"("stage", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "brand_brain_conversation_workspaceId_brandId_lastMessageAt_idx" ON "brand_brain_conversation"("workspaceId", "brandId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "brand_brain_conversation_expiresAt_idx" ON "brand_brain_conversation"("expiresAt");

-- CreateIndex
CREATE INDEX "brand_brain_message_conversationId_createdAt_idx" ON "brand_brain_message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "brand_brain_message_expiresAt_idx" ON "brand_brain_message"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "brand_brain_message_workspaceId_idempotencyKey_key" ON "brand_brain_message"("workspaceId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "brand" ADD CONSTRAINT "brand_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_knowledge_item" ADD CONSTRAINT "brand_knowledge_item_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_knowledge_item" ADD CONSTRAINT "brand_knowledge_item_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_knowledge_item" ADD CONSTRAINT "brand_knowledge_item_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "brand_source_document"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "brand_knowledge_item" ADD CONSTRAINT "brand_knowledge_item_conflictsWithItemId_fkey" FOREIGN KEY ("conflictsWithItemId") REFERENCES "brand_knowledge_item"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "brand_knowledge_version" ADD CONSTRAINT "brand_knowledge_version_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_knowledge_version" ADD CONSTRAINT "brand_knowledge_version_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_knowledge_version" ADD CONSTRAINT "brand_knowledge_version_knowledgeItemId_fkey" FOREIGN KEY ("knowledgeItemId") REFERENCES "brand_knowledge_item"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "brand_source_document" ADD CONSTRAINT "brand_source_document_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_source_document" ADD CONSTRAINT "brand_source_document_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_source_chunk" ADD CONSTRAINT "brand_source_chunk_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_source_chunk" ADD CONSTRAINT "brand_source_chunk_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_source_chunk" ADD CONSTRAINT "brand_source_chunk_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "brand_source_document"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "brand_knowledge_candidate" ADD CONSTRAINT "brand_knowledge_candidate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_knowledge_candidate" ADD CONSTRAINT "brand_knowledge_candidate_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_knowledge_candidate" ADD CONSTRAINT "brand_knowledge_candidate_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "brand_source_document"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "brand_knowledge_candidate" ADD CONSTRAINT "brand_knowledge_candidate_targetItemId_fkey" FOREIGN KEY ("targetItemId") REFERENCES "brand_knowledge_item"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "brand_ingestion_job" ADD CONSTRAINT "brand_ingestion_job_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_ingestion_job" ADD CONSTRAINT "brand_ingestion_job_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_ingestion_job" ADD CONSTRAINT "brand_ingestion_job_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "brand_source_document"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "brand_brain_conversation" ADD CONSTRAINT "brand_brain_conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_brain_conversation" ADD CONSTRAINT "brand_brain_conversation_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_brain_message" ADD CONSTRAINT "brand_brain_message_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_brain_message" ADD CONSTRAINT "brand_brain_message_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_brain_message" ADD CONSTRAINT "brand_brain_message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "brand_brain_conversation"("id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- ---------------------------------------------------------------------------
-- Row-level security
--
-- Every table here is tenant-owned, so every one gets ENABLE + FORCE, a
-- tenant policy keyed on `app.current_workspace_id()`, and a platform policy.
-- FORCE matters because the migrator owns these tables: without it the owner
-- would bypass its own policies.
-- ---------------------------------------------------------------------------

ALTER TABLE "brand"                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand"                      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_item"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_item"       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_version"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_version"    FORCE  ROW LEVEL SECURITY;
ALTER TABLE "brand_source_document"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_source_document"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "brand_source_chunk"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_source_chunk"         FORCE  ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_candidate"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_candidate"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "brand_ingestion_job"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_ingestion_job"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_conversation"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_conversation"   FORCE  ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_message"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_message"        FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "brand"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "brand_knowledge_item"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "brand_knowledge_version"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "brand_source_document"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "brand_source_chunk"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "brand_knowledge_candidate"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "brand_ingestion_job"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "brand_brain_conversation"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "brand_brain_message"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "brand"                     TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "brand_knowledge_item"      TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "brand_knowledge_version"   TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "brand_source_document"     TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "brand_source_chunk"        TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "brand_knowledge_candidate" TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "brand_ingestion_job"       TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "brand_brain_conversation"  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "brand_brain_message"       TO brandspace_platform USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON "brand"                      TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_knowledge_item"       TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_source_document"      TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_source_chunk"         TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_knowledge_candidate"  TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_ingestion_job"        TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_brain_conversation"   TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "brand_brain_message"        TO brandspace_app, brandspace_platform;

-- APPEND-ONLY. The version history is the evidence that nothing was silently
-- overwritten (D-65). A history a service can rewrite proves nothing, so the
-- privilege is withheld and a trigger refuses it even from the owner.
GRANT SELECT, INSERT ON "brand_knowledge_version" TO brandspace_app, brandspace_platform;
REVOKE UPDATE, DELETE ON "brand_knowledge_version" FROM brandspace_app;
REVOKE UPDATE, DELETE ON "brand_knowledge_version" FROM brandspace_platform;

CREATE OR REPLACE FUNCTION app.brand_knowledge_version_is_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'brand_knowledge_version is append-only: % is not permitted. A correction is a new version.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER brand_knowledge_version_append_only
  BEFORE UPDATE OR DELETE ON "brand_knowledge_version"
  FOR EACH ROW EXECUTE FUNCTION app.brand_knowledge_version_is_append_only();

-- ---------------------------------------------------------------------------
-- One live ingestion job per document.
--
-- Two uploads racing the same file must not both process it. A partial unique
-- index over the non-terminal stages is what makes "at most one in flight"
-- true under concurrency; a SELECT-then-INSERT in a service is not.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "brand_ingestion_job_one_live"
  ON "brand_ingestion_job" ("sourceDocumentId")
  WHERE "stage" IN ('QUEUED', 'EXTRACTING', 'CHUNKING', 'EXTRACTING_FACTS');
