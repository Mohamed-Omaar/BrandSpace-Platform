-- ===========================================================================
-- Phase 5B-3 — Approvals, Activity Log, Notifications
--
-- Three tenant-owned tables. `approval` records review CYCLES over content,
-- `approval_policy` records the per-brand rules those cycles are judged by
-- (ROADMAP Phase 5 scope item 6, "policy per brand"), and `notification`
-- records what each member has been told and whether they have read it.
--
-- THE ACTIVITY LOG ADDS NO TABLE. It is a read model over `audit_event`, which
-- already exists, is already RLS-protected on `workspaceId`, and is already
-- append-only for both roles by REVOKE plus a trigger. Giving the customer
-- screen its own event table would have meant two records of the same facts
-- that drift apart, and a mutable one at that — AC-15.7 exists to prevent
-- exactly that.
--
-- WHY `notification` IS A TABLE AND NOT A VIEW OVER `audit_event`. Unread
-- state is per reader and MUTABLE. `audit_event` is append-only on purpose, so
-- a `readAt` could never live there without weakening the guarantee the audit
-- trail is for.
--
-- EVERY FOREIGN KEY TO A TENANT-OWNED PARENT IS COMPOSITE ON `workspaceId`
-- (D-112). PostgreSQL evaluates referential integrity as the table OWNER with
-- RLS BYPASSED, so a plain `contentItemId` accepts another workspace's draft
-- and the difference between "inserted" and "violates foreign key" answers
-- "does that id exist?". F-80 and F-83 are what this prevents recurring.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Enums.
-- ---------------------------------------------------------------------------

CREATE TYPE "ApprovalStatus" AS ENUM (
  'PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'CANCELLED'
);

CREATE TYPE "ApprovalSubjectType" AS ENUM ('CONTENT_ITEM', 'CAMPAIGN', 'ASSET');

CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH');

-- ---------------------------------------------------------------------------
-- 2. `approval` — one row per review cycle.
--
-- Resubmitting after changes were requested opens a NEW cycle rather than
-- reopening the closed one, so "who approved this, when, and against which
-- policy" keeps a stable answer after the next edit. `policySnapshot` is
-- snapshotted rather than joined for the same reason.
-- ---------------------------------------------------------------------------

CREATE TABLE "approval" (
  "id"                UUID NOT NULL,
  "workspaceId"       UUID NOT NULL,
  "brandId"           UUID NOT NULL,

  "subjectType"       "ApprovalSubjectType" NOT NULL DEFAULT 'CONTENT_ITEM',
  "contentItemId"     UUID,

  "requestedByUserId" UUID NOT NULL,
  "assignedToUserId"  UUID,

  "status"            "ApprovalStatus" NOT NULL DEFAULT 'PENDING',

  "requestNote"       TEXT,
  "decisionNote"      TEXT,

  "decidedByUserId"   UUID,
  "decidedAt"         TIMESTAMPTZ(6),

  "policySnapshot"    JSONB,
  "cycle"             INTEGER NOT NULL DEFAULT 1,

  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- A CONTENT_ITEM approval must name its item, and an approval that names no
-- subject is a queue entry pointing at nothing. The check is here rather than
-- in the service because the service is one of several possible writers.
ALTER TABLE "approval"
  ADD CONSTRAINT "approval_subject_present"
  CHECK ("subjectType" <> 'CONTENT_ITEM' OR "contentItemId" IS NOT NULL);

-- A decided approval carries its decider and its timestamp; a pending one
-- carries neither. Half a decision is not a state the history can render.
ALTER TABLE "approval"
  ADD CONSTRAINT "approval_decision_consistent"
  CHECK (
    ("status" IN ('PENDING', 'CANCELLED') AND "decidedByUserId" IS NULL AND "decidedAt" IS NULL)
    OR
    ("status" IN ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED')
      AND "decidedByUserId" IS NOT NULL AND "decidedAt" IS NOT NULL)
  );

ALTER TABLE "approval" ADD CONSTRAINT "approval_cycle_positive" CHECK ("cycle" >= 1);

-- ---------------------------------------------------------------------------
-- 3. `approval_policy` — the per-brand rules.
--
-- ABSENCE IS NOT A STATE. Every column is NULLABLE and NULL means "use the
-- activated `content.approvals` default", so changing a default still reaches
-- every brand that never deliberately departed from it. A row with all three
-- NULL is indistinguishable from no row, which is correct.
-- ---------------------------------------------------------------------------

CREATE TABLE "approval_policy" (
  "id"                              UUID NOT NULL,
  "workspaceId"                     UUID NOT NULL,
  "brandId"                         UUID NOT NULL,

  "requireApprovalBeforeScheduling" BOOLEAN,
  "allowSelfApproval"               BOOLEAN,
  "clientApprovalEnabled"           BOOLEAN,

  "updatedByUserId"                 UUID,
  "createdAt"                       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"                       TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "approval_policy_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 4. `notification` — per-member, per-event, with the one mutable column.
--
-- `userId` is NOT NULL. A workspace-wide notification would have no per-reader
-- unread state, which is the single thing this table exists to hold; fan-out
-- to several members is several rows, each independently readable.
--
-- The rendered TEXT is deliberately not stored. The reader's locale is known at
-- read time, and storing one language would make the inbox monolingual in a
-- workspace that is not.
-- ---------------------------------------------------------------------------

CREATE TABLE "notification" (
  "id"             UUID NOT NULL,
  "workspaceId"    UUID NOT NULL,
  "userId"         UUID NOT NULL,

  "templateKey"    TEXT NOT NULL,
  "payload"        JSONB,
  "channel"        "NotificationChannel" NOT NULL DEFAULT 'IN_APP',

  "linkPath"       TEXT,
  "brandId"        UUID,
  "resourceType"   TEXT,
  "resourceId"     UUID,

  "readAt"         TIMESTAMPTZ(6),
  "idempotencyKey" TEXT NOT NULL,

  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- A deep link is workspace-relative and locale-prefixed at render time. An
-- absolute URL here would be a redirect target written by one tenant and
-- followed by another's browser.
ALTER TABLE "notification"
  ADD CONSTRAINT "notification_link_is_relative"
  CHECK ("linkPath" IS NULL OR "linkPath" ~ '^/[A-Za-z0-9/_\-?=&.]*$');

-- Only IN_APP is deliverable in this phase (D-123). The enum carries the rest
-- because docs/DATABASE.md §9.3 designs them; the CHECK is what stops a row
-- claiming a delivery this platform cannot perform.
ALTER TABLE "notification"
  ADD CONSTRAINT "notification_channel_is_deliverable"
  CHECK ("channel" = 'IN_APP');

-- ---------------------------------------------------------------------------
-- 5. Foreign keys. Every reference to a tenant-owned parent is COMPOSITE on
--    `workspaceId` (D-112).
-- ---------------------------------------------------------------------------

ALTER TABLE "approval"
  ADD CONSTRAINT "approval_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "approval"
  ADD CONSTRAINT "approval_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "approval"
  ADD CONSTRAINT "approval_item_fkey"
  FOREIGN KEY ("workspaceId", "contentItemId") REFERENCES "content_item"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "approval_policy"
  ADD CONSTRAINT "approval_policy_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "approval_policy"
  ADD CONSTRAINT "approval_policy_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification"
  ADD CONSTRAINT "notification_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. Indexes.
-- ---------------------------------------------------------------------------

CREATE INDEX "approval_workspaceId_status_createdAt_idx"
  ON "approval" ("workspaceId", "status", "createdAt" DESC);
CREATE INDEX "approval_workspaceId_contentItemId_cycle_idx"
  ON "approval" ("workspaceId", "contentItemId", "cycle" DESC);
CREATE INDEX "approval_workspaceId_assignedToUserId_status_idx"
  ON "approval" ("workspaceId", "assignedToUserId", "status");
CREATE INDEX "approval_workspaceId_brandId_status_idx"
  ON "approval" ("workspaceId", "brandId", "status");

CREATE UNIQUE INDEX "approval_policy_workspaceId_brandId_key"
  ON "approval_policy" ("workspaceId", "brandId");

CREATE UNIQUE INDEX "notification_workspaceId_idempotencyKey_key"
  ON "notification" ("workspaceId", "idempotencyKey");
CREATE INDEX "notification_workspaceId_userId_readAt_createdAt_idx"
  ON "notification" ("workspaceId", "userId", "readAt", "createdAt" DESC);
CREATE INDEX "notification_workspaceId_userId_createdAt_idx"
  ON "notification" ("workspaceId", "userId", "createdAt" DESC);

-- ---------------------------------------------------------------------------
-- 7. ONE OPEN REVIEW PER CONTENT ITEM — a PARTIAL unique index.
--
-- Two pending approvals for the same draft is two reviewers each believing
-- their verdict decided it. The service refusing that is not the same as the
-- database refusing it: a second call site, a job or a raw statement bypasses
-- the service. PARTIAL on `status = 'PENDING'`, so a closed cycle does not
-- block the next one — the shape D-100 settled and D-118 reused, and it lives
-- here because Prisma cannot model a WHERE clause on a unique index (and
-- `migrate diff` does not model it either, so it produces no drift).
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "approval_one_open_per_item"
  ON "approval" ("workspaceId", "contentItemId")
  WHERE "status" = 'PENDING';

-- ---------------------------------------------------------------------------
-- 8. Row-Level Security. ENABLED and FORCED on all three.
--
-- FORCE matters as much as ENABLE: without it the policy does not apply to the
-- table's OWNER, so a migration or maintenance statement running as owner would
-- see every tenant at once (D-113).
-- ---------------------------------------------------------------------------

ALTER TABLE "approval"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "approval_policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_policy" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "notification"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification"    FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "approval"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
CREATE POLICY platform_access ON "approval"
  TO brandspace_platform USING (true) WITH CHECK (true);

CREATE POLICY tenant_isolation ON "approval_policy"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
CREATE POLICY platform_access ON "approval_policy"
  TO brandspace_platform USING (true) WITH CHECK (true);

CREATE POLICY tenant_isolation ON "notification"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
CREATE POLICY platform_access ON "notification"
  TO brandspace_platform USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 9. Privileges — least privilege, as everywhere else.
--
-- `notification` is the only one of the three the application may DELETE, and
-- it may: a read notification the member dismisses is their own data, not a
-- record anybody else relies on. The AUDIT trail of the underlying event is
-- what survives, and it is untouched by this migration.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON "approval"        TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "approval_policy" TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification"    TO brandspace_app, brandspace_platform;

COMMIT;
