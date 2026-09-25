-- Q12 (prototype v90, Phase 2A): note triage moves behind `notes.manage`.
--
-- Until now one permission, `content.read`, let a member read, start, reply to,
-- resolve, reopen and assign note threads and set their due date and
-- importance. The code this release ships asks `notes.manage` for everything
-- but reading, starting and replying to an open thread. This migration makes
-- sure no member loses anything when that code arrives: every role that holds
-- `content.read` right now is granted `notes.manage` as well.
--
-- DATA ONLY, ADDITIVE, IDEMPOTENT.
--   - It inserts rows and never updates or deletes one. `ON CONFLICT DO
--     NOTHING` on both statements, so re-running it changes nothing.
--   - SAFE WHILE THE PREVIOUS RELEASE IS LIVE. The previous code never asks for
--     `notes.manage`, so an extra grant is invisible to it; nothing it reads
--     changes shape.
--   - It grants NOTHING ELSE. In particular `client_viewer` does not hold
--     `content.read` today, so it receives nothing here; giving the Viewer
--     `content.read` is a separate, later release.
--   - The catalogue definitions (`ALL_PERMISSIONS`, `ROLE_DEFINITIONS` in
--     @brandspace/shared) carry the same key and grants, so the seed and the
--     bootstrap commands produce identical rows on a fresh database;
--     `tests/isolation/q12-notes-manage-migration.test.ts` compares the two.
--
-- `role_permission` and `permission` are global catalogue tables without
-- row-level security, so the owner running this migration sees every grant.
-- `role` is not read at all: a grant of `content.read` can only exist on a
-- workspace-realm role, because permissions and roles never cross realms.

BEGIN;

INSERT INTO "permission" ("id", "key", "resource", "action", "minScope", "description", "createdAt")
VALUES (
  gen_random_uuid(),
  'notes.manage',
  'notes',
  'manage',
  'workspace',
  'Resolve, assign and triage note threads',
  now()
)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("roleId", "permissionId")
SELECT rp."roleId", notes_manage."id"
  FROM "role_permission" rp
  JOIN "permission" content_read
    ON content_read."id" = rp."permissionId" AND content_read."key" = 'content.read'
 CROSS JOIN "permission" notes_manage
 WHERE notes_manage."key" = 'notes.manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
