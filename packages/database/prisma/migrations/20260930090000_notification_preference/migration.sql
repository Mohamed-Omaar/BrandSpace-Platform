-- Prototype v94 Phase 2B-1, A10 / G2 (D-331): per-person notification switches.
--
-- SCHEMA ONLY, ADDITIVE. One new tenant-owned table with ENABLE + FORCE RLS,
-- the same `tenant_isolation` / `platform_access` policies and grants as
-- "notification", foreign keys to the workspace and the person, one unique
-- index and one CHECK. No row is inserted, updated or deleted, so a freshly
-- migrated EMPTY database stays empty — and an existing one too: NO ROW MEANS
-- ON, so every member keeps receiving everything until they switch something
-- off themselves.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. That release never reads or writes
-- this table; it keeps delivering every notification, which is exactly what an
-- empty table means to the new release as well.
--
-- ROLLBACK is by a forward migration (drop the table), never by replaying or
-- editing this file.

CREATE TABLE "notification_preference" (
  "id"          UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "userId"      UUID NOT NULL,
  "category"    TEXT NOT NULL,
  "enabled"     BOOLEAN NOT NULL,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- The four categories the settings screen offers, and nothing else.
ALTER TABLE "notification_preference"
  ADD CONSTRAINT "notification_preference_category_known"
  CHECK ("category" IN ('approvals', 'publishing', 'automations', 'brand_brain_reviews'));

-- One switch per person per category per workspace.
CREATE UNIQUE INDEX "notification_preference_workspaceId_userId_category_key"
  ON "notification_preference" ("workspaceId", "userId", "category");

ALTER TABLE "notification_preference"
  ADD CONSTRAINT "notification_preference_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A person's switches go with the person.
ALTER TABLE "notification_preference"
  ADD CONSTRAINT "notification_preference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preference" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "notification_preference"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());
CREATE POLICY platform_access ON "notification_preference"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_preference" TO brandspace_app, brandspace_platform;
