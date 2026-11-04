-- Creative generation jobs — PR 1 (Images), owner decisions 2026-11-04.
--
-- Image generation becomes a background job. The request returns at once with
-- a job id; the api process generates the image from a queue it consumes
-- itself (F-07: an ordinary worker may not hold the AI gateway); the screen
-- follows the job's row; and an image asked for from a post is attached to
-- that post's variant on the server when the job finishes, audited, even if
-- the editor is closed. The post still needs approval before publishing.
--
--   creative_generation_job — TENANT: one image asked for, by one person, for
--                             one brand, optionally for one post variant.
--
-- The row is the state; the queue message is only a pointer to it (the
-- ingestion job pattern, D-413). Status moves QUEUED -> RUNNING -> SUCCEEDED
-- or FAILED, by compare-and-set in code. Credits stay on the AI gateway's own
-- reserve -> confirm -> settle ledger: this table records only the outcome.
--
-- FORWARD-ONLY and additive: one new table, its indexes, policies and grants.
-- No existing table, row, policy or grant changes.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "creative_generation_job" (
  "id"                  UUID           NOT NULL,
  "workspaceId"         UUID           NOT NULL,
  "brandId"             UUID           NOT NULL,
  -- Who asked. Kept when the person leaves the workspace's users (SET NULL).
  "requestedByUserId"   UUID,
  -- The client's de-duplication key: one key, one job, one charge. A
  -- de-duplication token, never a credential: every lookup also matches the
  -- person and the brand (P7-R2).
  "idempotencyKey"      TEXT           NOT NULL,
  -- CUSTOMER CONTENT: the brief as typed.
  "brief"               TEXT           NOT NULL,
  "formatKey"           TEXT           NOT NULL,
  "quality"             TEXT,
  -- The post variant to attach the image to, when it was asked for from a post.
  -- Removing the variant keeps the job and clears only this column.
  "contentVariantId"    UUID,
  "status"              TEXT           NOT NULL DEFAULT 'QUEUED',
  "attempts"            INTEGER        NOT NULL DEFAULT 0,
  -- The image, once stored. Removing the asset keeps the job's history.
  "assetId"             UUID,
  -- The AI gateway request that produced it (provenance and cost).
  "aiRequestId"         UUID,
  "creditsChargedMilli" BIGINT,
  -- When the image was added to the variant; null when it was not (no
  -- variant, the variant was gone, or the image was already there).
  "attachedAt"          TIMESTAMPTZ(6),
  -- A stable reason key the dashboard translates; never a provider's words.
  "failureReason"       TEXT,
  "createdAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"           TIMESTAMPTZ(6),
  "completedAt"         TIMESTAMPTZ(6),
  CONSTRAINT "creative_generation_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "creative_generation_job_workspace_fkey" FOREIGN KEY ("workspaceId")
    REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "creative_generation_job_brand_fkey" FOREIGN KEY ("workspaceId", "brandId")
    REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "creative_generation_job_requester_fkey" FOREIGN KEY ("requestedByUserId")
    REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "creative_generation_job_variant_fkey" FOREIGN KEY ("workspaceId", "contentVariantId")
    REFERENCES "content_variant"("workspaceId", "id") ON DELETE SET NULL ("contentVariantId") ON UPDATE NO ACTION,
  CONSTRAINT "creative_generation_job_asset_fkey" FOREIGN KEY ("workspaceId", "assetId")
    REFERENCES "asset"("workspaceId", "id") ON DELETE SET NULL ("assetId") ON UPDATE NO ACTION,
  CONSTRAINT "creative_generation_job_ai_request_fkey" FOREIGN KEY ("workspaceId", "aiRequestId")
    REFERENCES "ai_request"("workspaceId", "id") ON DELETE SET NULL ("aiRequestId") ON UPDATE NO ACTION,
  CONSTRAINT "creative_generation_job_status_known" CHECK ("status" IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  CONSTRAINT "creative_generation_job_quality_known" CHECK ("quality" IS NULL OR "quality" IN ('low', 'medium', 'high')),
  CONSTRAINT "creative_generation_job_key_shape" CHECK (char_length("idempotencyKey") BETWEEN 1 AND 200),
  CONSTRAINT "creative_generation_job_brief_length" CHECK (char_length("brief") BETWEEN 1 AND 4000),
  CONSTRAINT "creative_generation_job_format_shape" CHECK ("formatKey" ~ '^[a-z0-9_.-]{1,60}$'),
  CONSTRAINT "creative_generation_job_reason_shape" CHECK ("failureReason" IS NULL OR "failureReason" ~ '^[a-z0-9_]{1,60}$'),
  CONSTRAINT "creative_generation_job_attempts_range" CHECK ("attempts" BETWEEN 0 AND 10),
  CONSTRAINT "creative_generation_job_charge_range" CHECK ("creditsChargedMilli" IS NULL OR "creditsChargedMilli" >= 0),
  -- Finished means a finish time; a failure carries its reason; only a success is attached.
  CONSTRAINT "creative_generation_job_finished_shape" CHECK (
    ("status" IN ('SUCCEEDED', 'FAILED')) = ("completedAt" IS NOT NULL)),
  CONSTRAINT "creative_generation_job_failure_shape" CHECK (
    ("status" = 'FAILED') = ("failureReason" IS NOT NULL)),
  CONSTRAINT "creative_generation_job_attached_shape" CHECK (
    "attachedAt" IS NULL OR "status" = 'SUCCEEDED')
);
CREATE UNIQUE INDEX "creative_generation_job_workspaceId_id_key"
  ON "creative_generation_job" ("workspaceId", "id");
CREATE UNIQUE INDEX "creative_generation_job_workspaceId_idempotencyKey_key"
  ON "creative_generation_job" ("workspaceId", "idempotencyKey");
-- The recovery sweep: unfinished jobs, oldest first.
CREATE INDEX "creative_generation_job_status_createdAt_idx"
  ON "creative_generation_job" ("status", "createdAt")
  WHERE "status" IN ('QUEUED', 'RUNNING');
-- A post's jobs (the editor shows a job in progress on its variant).
CREATE INDEX "creative_generation_job_workspaceId_contentVariantId_idx"
  ON "creative_generation_job" ("workspaceId", "contentVariantId");
-- A person's recent jobs on a brand (the Creative Studio page).
CREATE INDEX "creative_generation_job_brand_requester_createdAt_idx"
  ON "creative_generation_job" ("workspaceId", "brandId", "requestedByUserId", "createdAt" DESC);
CREATE INDEX "creative_generation_job_requestedByUserId_idx"
  ON "creative_generation_job" ("requestedByUserId");

-- Row-level security -------------------------------------------------------
ALTER TABLE "creative_generation_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "creative_generation_job" FORCE  ROW LEVEL SECURITY;

-- The tenant role: this workspace only, for reading and writing.
CREATE POLICY tenant_isolation ON "creative_generation_job" TO brandspace_app
  USING ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- The platform role: the recovery sweep finds unfinished jobs across workspaces.
CREATE POLICY platform_access ON "creative_generation_job" TO brandspace_platform
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "creative_generation_job"
  TO brandspace_app, brandspace_platform;

-- Proof: RLS is enabled and forced, and the tenant policy names the workspace.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE relname = 'creative_generation_job'
                    AND relnamespace = 'public'::regnamespace
                    AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'creative_generation_job: RLS not forced';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'creative_generation_job'
                    AND policyname = 'tenant_isolation'
                    AND roles = '{brandspace_app}'
                    AND qual LIKE '%current_workspace_id()%'
                    AND with_check LIKE '%current_workspace_id()%') THEN
    RAISE EXCEPTION 'creative_generation_job: tenant policy missing or not workspace-scoped';
  END IF;
END $$;

COMMIT;
