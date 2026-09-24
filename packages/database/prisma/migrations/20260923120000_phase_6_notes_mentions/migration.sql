-- ---------------------------------------------------------------------------
-- PHASE 6 (P6-05) — CONTEXTUAL COLLABORATION: THREADS, NOTES AND MENTIONS.
--
-- Three tenant-owned tables. Every one carries `workspaceId`, ENABLE + FORCE
-- row-level security, a tenant policy keyed on `app.current_workspace_id()`,
-- a platform policy, and explicit grants — CLAUDE.md §2.1's two independent
-- layers, of which this is the second.
--
-- NOTHING HERE TOUCHES BRAND BRAIN. There is no foreign key into
-- `brand_knowledge_item`, no shared table and no trigger between them. A note
-- is what a colleague said; brand knowledge is what the brand has decided is
-- true and what every AI surface generates from. The separation is structural
-- so that it cannot be undone by forgetting.
-- ---------------------------------------------------------------------------

CREATE TYPE "NoteSubjectType" AS ENUM ('CONTENT_ITEM', 'CAMPAIGN', 'BRAND');
CREATE TYPE "NoteThreadStatus" AS ENUM ('OPEN', 'RESOLVED');

-- --- note_thread -----------------------------------------------------------

CREATE TABLE "note_thread" (
  "id"               UUID NOT NULL,
  "workspaceId"      UUID NOT NULL,
  "brandId"          UUID NOT NULL,
  "subjectType"      "NoteSubjectType" NOT NULL,
  "contentItemId"    UUID,
  "campaignId"       UUID,
  "status"           "NoteThreadStatus" NOT NULL DEFAULT 'OPEN',
  "createdByUserId"  UUID NOT NULL,
  "assignedToUserId" UUID,
  "resolvedAt"       TIMESTAMPTZ(6),
  "resolvedByUserId" UUID,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"        TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "note_thread_pkey" PRIMARY KEY ("id")
);

-- EXACTLY ONE SUBJECT, MATCHING THE DISCRIMINATOR.
--
-- Without this the enum and the foreign keys can disagree: a row saying
-- CONTENT_ITEM while carrying a campaign id, or carrying both, or neither. Every
-- reader would then have to decide which field it trusts, and they would not all
-- decide the same way. When the subject is the BRAND, both are null and
-- `brandId` — which is never null — is the subject.
ALTER TABLE "note_thread"
  ADD CONSTRAINT "note_thread_subject_exactly_one"
  CHECK (
    ("subjectType" = 'CONTENT_ITEM' AND "contentItemId" IS NOT NULL AND "campaignId" IS NULL)
    OR ("subjectType" = 'CAMPAIGN'  AND "campaignId"    IS NOT NULL AND "contentItemId" IS NULL)
    OR ("subjectType" = 'BRAND'     AND "contentItemId" IS NULL     AND "campaignId"    IS NULL)
  );

-- A resolved thread records WHEN and BY WHOM, and an open one records neither.
-- The same rule `calendar_slot_cancelled_consistently` applies to cancellation,
-- and for the same reason: two facts that can disagree are two facts nobody can
-- rely on.
ALTER TABLE "note_thread"
  ADD CONSTRAINT "note_thread_resolved_consistently"
  CHECK (
    ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "resolvedByUserId" IS NOT NULL)
    OR ("status" = 'OPEN'  AND "resolvedAt" IS NULL     AND "resolvedByUserId" IS NULL)
  );

CREATE UNIQUE INDEX "note_thread_workspaceId_id_key" ON "note_thread" ("workspaceId", "id");
CREATE INDEX "note_thread_workspaceId_brandId_subjectType_status_idx"
  ON "note_thread" ("workspaceId", "brandId", "subjectType", "status");
CREATE INDEX "note_thread_workspaceId_contentItemId_idx" ON "note_thread" ("workspaceId", "contentItemId");
CREATE INDEX "note_thread_workspaceId_campaignId_idx" ON "note_thread" ("workspaceId", "campaignId");
CREATE INDEX "note_thread_workspaceId_assignedToUserId_status_idx"
  ON "note_thread" ("workspaceId", "assignedToUserId", "status");

-- --- note ------------------------------------------------------------------

CREATE TABLE "note" (
  "id"           UUID NOT NULL,
  "workspaceId"  UUID NOT NULL,
  "threadId"     UUID NOT NULL,
  "authorUserId" UUID NOT NULL,
  "body"         TEXT NOT NULL,
  "editedAt"     TIMESTAMPTZ(6),
  "deletedAt"    TIMESTAMPTZ(6),
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "note_pkey" PRIMARY KEY ("id")
);

-- A note says something. An empty one is a row somebody created by accident,
-- and it would still raise a notification for everyone mentioned in it.
ALTER TABLE "note"
  ADD CONSTRAINT "note_body_not_blank" CHECK (length(btrim("body")) > 0);

CREATE UNIQUE INDEX "note_workspaceId_id_key" ON "note" ("workspaceId", "id");
CREATE INDEX "note_workspaceId_threadId_createdAt_idx" ON "note" ("workspaceId", "threadId", "createdAt");

-- --- note_mention ----------------------------------------------------------

CREATE TABLE "note_mention" (
  "id"              UUID NOT NULL,
  "workspaceId"     UUID NOT NULL,
  "noteId"          UUID NOT NULL,
  "mentionedUserId" UUID NOT NULL,
  "readAt"          TIMESTAMPTZ(6),
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "note_mention_pkey" PRIMARY KEY ("id")
);

-- Saying somebody's name twice in one sentence is not two notifications.
CREATE UNIQUE INDEX "note_mention_workspaceId_noteId_mentionedUserId_key"
  ON "note_mention" ("workspaceId", "noteId", "mentionedUserId");
CREATE UNIQUE INDEX "note_mention_workspaceId_id_key" ON "note_mention" ("workspaceId", "id");
CREATE INDEX "note_mention_workspaceId_mentionedUserId_readAt_idx"
  ON "note_mention" ("workspaceId", "mentionedUserId", "readAt");

-- --- foreign keys ----------------------------------------------------------
--
-- COMPOSITE, THROUGH `workspaceId` (F-80). A single-column reference would let a
-- row in workspace A point at a subject in workspace B and the database would
-- accept it; carrying the tenant key into the reference makes that
-- unrepresentable rather than merely forbidden.

ALTER TABLE "note_thread"
  ADD CONSTRAINT "note_thread_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "note_thread"
  ADD CONSTRAINT "note_thread_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "note_thread"
  ADD CONSTRAINT "note_thread_content_item_fkey"
  FOREIGN KEY ("workspaceId", "contentItemId") REFERENCES "content_item"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "note_thread"
  ADD CONSTRAINT "note_thread_campaign_fkey"
  FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "campaign"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "note"
  ADD CONSTRAINT "note_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "note"
  ADD CONSTRAINT "note_thread_fkey"
  FOREIGN KEY ("workspaceId", "threadId") REFERENCES "note_thread"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "note_mention"
  ADD CONSTRAINT "note_mention_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "note_mention"
  ADD CONSTRAINT "note_mention_note_fkey"
  FOREIGN KEY ("workspaceId", "noteId") REFERENCES "note"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- --- row-level security ----------------------------------------------------

ALTER TABLE "note_thread"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_thread"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "note"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note"         FORCE  ROW LEVEL SECURITY;
ALTER TABLE "note_mention" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note_mention" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "note_thread"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "note"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "note_mention"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "note_thread"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "note"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "note_mention"
  TO brandspace_platform USING (true) WITH CHECK (true);

-- --- grants ----------------------------------------------------------------
--
-- The application role may DELETE a MENTION (a note being edited drops the
-- people it no longer names) but not a NOTE or a THREAD: a conversation is
-- evidence of who asked for what, and notes are soft-deleted so the thread
-- keeps its shape. The platform role keeps DELETE for tenant offboarding and
-- the retention purge, exactly as D-128 sets it for approvals.

GRANT SELECT, INSERT, UPDATE ON "note_thread" TO brandspace_app;
GRANT SELECT, INSERT, UPDATE ON "note"        TO brandspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "note_mention" TO brandspace_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON "note_thread"  TO brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "note"         TO brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "note_mention" TO brandspace_platform;
