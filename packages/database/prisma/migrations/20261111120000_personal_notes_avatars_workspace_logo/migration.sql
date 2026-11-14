-- PR D — personal notes with reminders, person avatars, the workspace logo.
-- Owner brief "PR D", 2026-11-11. SENT FOR APPROVAL; not applied anywhere.
--
-- FORWARD-ONLY and ADDITIVE: one helper function, two new tables, four nullable
-- columns. No existing row, policy or grant changes. Nothing is backfilled.
--
--   app.current_user_id()   — the signed-in person, from a transaction-local
--                             setting the dashboard sets next to the workspace
--                             (`app.user_id`). NULL when unset, so a policy
--                             that compares with it matches NOTHING.
--   personal_note           — TENANT AND PERSONAL: one note, owned by one
--                             person, in one workspace. Readable and writable
--                             ONLY by its owner in that workspace. No platform
--                             policy and no platform grant: the Control Center
--                             cannot read it, whatever its code tries.
--   personal_note_reminder  — the note's reminder (at most one per note): when,
--                             in which zone, and its state. No note text in it.
--                             The platform role may read and update it, because
--                             the API's sweep finds the reminders that are due
--                             across workspaces; that is all it can see.
--   user.avatar*            — the person's avatar (a global identity, like
--                             their name): the object-store key of the cropped,
--                             scanned image, and when it changed.
--   workspace.logo*         — the workspace's logo, the same way.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. The signed-in person ----------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app.current_user_id() IS
  'The signed-in person, set transaction-locally by the dashboard beside app.workspace_id. '
  'NULL when unset: a personal policy then matches nothing (fail-closed).';

-- 2. Personal notes ----------------------------------------------------------
CREATE TABLE "personal_note" (
  "id"          UUID           NOT NULL,
  "workspaceId" UUID           NOT NULL,
  "ownerUserId" UUID           NOT NULL,
  -- CUSTOMER CONTENT, private to the owner.
  "title"       TEXT           NOT NULL DEFAULT '',
  "body"        TEXT           NOT NULL DEFAULT '',
  "pinnedAt"    TIMESTAMPTZ(6),
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "personal_note_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "personal_note_workspace_fkey" FOREIGN KEY ("workspaceId")
    REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- The person's notes go with the person.
  CONSTRAINT "personal_note_owner_fkey" FOREIGN KEY ("ownerUserId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "personal_note_title_length" CHECK (char_length("title") <= 200),
  CONSTRAINT "personal_note_body_length" CHECK (char_length("body") <= 20000),
  -- A note says something: a title, a body, or both.
  CONSTRAINT "personal_note_not_empty" CHECK (
    char_length(btrim("title")) > 0 OR char_length(btrim("body")) > 0)
);
CREATE UNIQUE INDEX "personal_note_workspaceId_id_key"
  ON "personal_note" ("workspaceId", "id");
-- The owner's list: pinned first, then the most recently changed.
CREATE INDEX "personal_note_owner_list_idx"
  ON "personal_note" ("workspaceId", "ownerUserId", "pinnedAt" DESC NULLS LAST, "updatedAt" DESC);
CREATE INDEX "personal_note_ownerUserId_idx" ON "personal_note" ("ownerUserId");

ALTER TABLE "personal_note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "personal_note" FORCE  ROW LEVEL SECURITY;

-- The tenant role: this workspace AND this person, for reading and writing.
CREATE POLICY personal_owner ON "personal_note" TO brandspace_app
  USING ("workspaceId" = app.current_workspace_id() AND "ownerUserId" = app.current_user_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id() AND "ownerUserId" = app.current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "personal_note" TO brandspace_app;
-- Deliberately NO policy and NO privilege for brandspace_platform. The schema's
-- default privileges give it every new table, so it is taken away here.
REVOKE ALL ON "personal_note" FROM brandspace_platform;

-- 3. Reminders ---------------------------------------------------------------
CREATE TABLE "personal_note_reminder" (
  "id"          UUID           NOT NULL,
  "workspaceId" UUID           NOT NULL,
  "ownerUserId" UUID           NOT NULL,
  "noteId"      UUID           NOT NULL,
  -- The instant, computed from the local date and time the person chose in
  -- their own zone; the zone is kept so the note shows the time they typed.
  "remindAt"    TIMESTAMPTZ(6) NOT NULL,
  "timeZone"    TEXT           NOT NULL,
  -- PENDING: waiting. SENT: the notification went out. DONE: marked done.
  -- Snooze moves `remindAt` and returns it to PENDING.
  "state"       TEXT           NOT NULL DEFAULT 'PENDING',
  "sentAt"      TIMESTAMPTZ(6),
  "emailSentAt" TIMESTAMPTZ(6),
  "doneAt"      TIMESTAMPTZ(6),
  "snoozeCount" INTEGER        NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "personal_note_reminder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "personal_note_reminder_workspace_fkey" FOREIGN KEY ("workspaceId")
    REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "personal_note_reminder_owner_fkey" FOREIGN KEY ("ownerUserId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- The note in the same workspace; the reminder goes with the note.
  CONSTRAINT "personal_note_reminder_note_fkey" FOREIGN KEY ("workspaceId", "noteId")
    REFERENCES "personal_note"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "personal_note_reminder_state_known"
    CHECK ("state" IN ('PENDING', 'SENT', 'DONE')),
  CONSTRAINT "personal_note_reminder_zone_shape"
    CHECK ("timeZone" ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$' AND char_length("timeZone") <= 64),
  CONSTRAINT "personal_note_reminder_sent_shape"
    CHECK (("state" = 'SENT') <= ("sentAt" IS NOT NULL)),
  CONSTRAINT "personal_note_reminder_done_shape"
    CHECK (("state" = 'DONE') = ("doneAt" IS NOT NULL)),
  CONSTRAINT "personal_note_reminder_snooze_range" CHECK ("snoozeCount" BETWEEN 0 AND 1000)
);
-- One reminder per note.
CREATE UNIQUE INDEX "personal_note_reminder_noteId_key"
  ON "personal_note_reminder" ("noteId");
CREATE UNIQUE INDEX "personal_note_reminder_workspaceId_id_key"
  ON "personal_note_reminder" ("workspaceId", "id");
-- The sweep: what is due, earliest first.
CREATE INDEX "personal_note_reminder_due_idx"
  ON "personal_note_reminder" ("remindAt") WHERE "state" = 'PENDING';
CREATE INDEX "personal_note_reminder_ownerUserId_idx"
  ON "personal_note_reminder" ("ownerUserId");

ALTER TABLE "personal_note_reminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "personal_note_reminder" FORCE  ROW LEVEL SECURITY;

CREATE POLICY personal_owner ON "personal_note_reminder" TO brandspace_app
  USING ("workspaceId" = app.current_workspace_id() AND "ownerUserId" = app.current_user_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id() AND "ownerUserId" = app.current_user_id());

-- The platform role: the API's sweep finds due reminders across workspaces and
-- marks them sent. It holds no note text.
CREATE POLICY platform_access ON "personal_note_reminder" TO brandspace_platform
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "personal_note_reminder" TO brandspace_app;
-- The sweep reads and updates; it never creates or deletes a reminder.
REVOKE ALL ON "personal_note_reminder" FROM brandspace_platform;
GRANT SELECT, UPDATE ON "personal_note_reminder" TO brandspace_platform;

-- 4. Avatars and the workspace logo -----------------------------------------
-- Object-store keys of images that passed the image rules (type by signature,
-- the image ceiling, never SVG) and the malware scan, cropped square in the
-- browser and shown in a circle. NULL = initials / letters.
ALTER TABLE "user" ADD COLUMN "avatarKey" TEXT;
ALTER TABLE "user" ADD COLUMN "avatarUpdatedAt" TIMESTAMPTZ(6);
ALTER TABLE "user" ADD CONSTRAINT "user_avatar_key_shape"
  CHECK ("avatarKey" IS NULL OR "avatarKey" ~ '^avatars/[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpeg|webp)$');
ALTER TABLE "user" ADD CONSTRAINT "user_avatar_pair"
  CHECK (("avatarKey" IS NULL) = ("avatarUpdatedAt" IS NULL));

ALTER TABLE "workspace" ADD COLUMN "logoKey" TEXT;
ALTER TABLE "workspace" ADD COLUMN "logoUpdatedAt" TIMESTAMPTZ(6);
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_logo_key_shape"
  CHECK ("logoKey" IS NULL OR "logoKey" ~ '^workspaces/[0-9a-f-]{36}/logo/[0-9a-f-]{36}\.(png|jpeg|webp)$');
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_logo_pair"
  CHECK (("logoKey" IS NULL) = ("logoUpdatedAt" IS NULL));

-- 5. Proof ------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = 'personal_note') THEN
    RAISE EXCEPTION 'personal_note must have RLS enabled and forced';
  END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = 'personal_note_reminder') THEN
    RAISE EXCEPTION 'personal_note_reminder must have RLS enabled and forced';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'personal_note' AND 'brandspace_platform' = ANY (roles)) THEN
    RAISE EXCEPTION 'personal_note must have no platform policy';
  END IF;
  IF has_table_privilege('brandspace_platform', 'personal_note', 'SELECT')
     OR has_table_privilege('brandspace_platform', 'personal_note', 'INSERT')
     OR has_table_privilege('brandspace_platform', 'personal_note', 'UPDATE')
     OR has_table_privilege('brandspace_platform', 'personal_note', 'DELETE') THEN
    RAISE EXCEPTION 'brandspace_platform must have no privilege on personal_note';
  END IF;
  IF has_table_privilege('brandspace_platform', 'personal_note_reminder', 'INSERT')
     OR has_table_privilege('brandspace_platform', 'personal_note_reminder', 'DELETE') THEN
    RAISE EXCEPTION 'brandspace_platform may only read and update personal_note_reminder';
  END IF;
END $$;

COMMIT;
