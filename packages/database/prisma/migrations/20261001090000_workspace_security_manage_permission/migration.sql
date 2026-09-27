-- Prototype v94 Phase 2B-1, G4 / Q23 (D-333): `workspace.security.manage`, the
-- Owner's authority to require two-step verification for everyone in the
-- workspace.
--
-- DATA ONLY, ADDITIVE, IDEMPOTENT.
--   - It inserts rows and never updates or deletes one. `ON CONFLICT DO
--     NOTHING` on both statements, so re-running it changes nothing.
--   - ONLY INTO A CATALOGUE THAT EXISTS. A freshly migrated database has no
--     permission rows at all — the seed or the production bootstrap writes the
--     whole catalogue from the definitions, this permission included — and a
--     migration must leave it empty (`tests/isolation/bootstrap-production-owner.test.ts`).
--   - OWNER ONLY. It is granted to exactly the roles that hold
--     `workspace.transfer_ownership`, which only the Owner holds (the Admin's
--     deny list excludes both). The `role` table is not read: it is under
--     FORCE row-level security and this migration's role has no policy there,
--     exactly as the Phase 2A note-triage migration notes. `ROLE_DEFINITIONS` in
--     @brandspace/shared carries the same grant, so the seed and the bootstrap
--     produce identical rows on a fresh database; the Q12 migration suite
--     compares an upgraded database with a fresh one.
--   - SAFE WHILE THE PREVIOUS RELEASE IS LIVE. The previous code never asks for
--     `workspace.security.manage`, so one more grant on the Owner is invisible
--     to it; nothing it reads changes shape.
--
-- `role_permission` and `permission` are global catalogue tables without
-- row-level security.

BEGIN;

INSERT INTO "permission" ("id", "key", "resource", "action", "minScope", "description", "createdAt")
SELECT
  gen_random_uuid(),
  'workspace.security.manage',
  'workspace',
  'security',
  'workspace',
  'Require two-step verification for everyone in the workspace',
  now()
 WHERE EXISTS (SELECT 1 FROM "permission" WHERE "key" = 'workspace.transfer_ownership')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permission" ("roleId", "permissionId")
SELECT rp."roleId", security_manage."id"
  FROM "role_permission" rp
  JOIN "permission" transfer
    ON transfer."id" = rp."permissionId" AND transfer."key" = 'workspace.transfer_ownership'
 CROSS JOIN "permission" security_manage
 WHERE security_manage."key" = 'workspace.security.manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
