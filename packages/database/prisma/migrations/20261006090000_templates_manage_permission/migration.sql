-- E4 / B2 (Phase 2B-2): the post-template permission, `templates.manage`.
--
-- WHAT IT GRANTS: `templates.manage` to the Owner, the Admin, the Marketing
-- Manager and the Designer (`workspace_owner`, `workspace_admin`,
-- `marketing_manager`, `designer`) — exactly `ROLE_DEFINITIONS`, which the seed
-- and both bootstrap commands write. Using a template needs no new key: it
-- prefills a post, and creating the post already needs `content.create`.
--
-- EVERY ROW WITH ONE OF THOSE KEYS, IN THE WORKSPACE REALM. As in
-- `20260927090000_q12_viewer_content_read`: `role.workspaceId` is nullable and
-- the unique key is (`workspaceId`, `key`), so the SYSTEM role and a
-- workspace-scoped role may both carry a key. The grant matches on the key
-- alone and reaches both.
--
-- DATA ONLY, ADDITIVE, IDEMPOTENT.
--   - It inserts one `permission` row and `role_permission` rows, and never
--     updates or deletes one. `ON CONFLICT DO NOTHING` on both, so re-running
--     it changes nothing.
--   - ONLY WHEN THE CATALOGUE EXISTS. On a freshly migrated, EMPTY database
--     there is no `content.create` permission and no role, so it inserts
--     nothing at all; the seed or the bootstrap then writes the whole
--     catalogue from the definitions, this key and these grants included.
--   - SAFE WHILE THE PREVIOUS RELEASE IS LIVE. That release never reads the
--     key; a role holding a permission nothing checks changes nothing it does.
--
-- READING `role` NEEDS FORCE LIFTED (D-112 pattern). `role` is ENABLE + FORCE
-- RLS with no policy for the migrator, so under FORCE the join below would see
-- zero roles and the grant would silently do nothing. FORCE is lifted inside
-- this transaction only, restored before COMMIT and asserted.

BEGIN;

INSERT INTO "permission" ("id", "key", "resource", "action", "minScope", "description", "createdAt")
SELECT gen_random_uuid(), 'templates.manage', 'templates', 'manage', 'workspace',
       'Save, change and delete post templates, and set the default', now()
 WHERE EXISTS (SELECT 1 FROM "permission" WHERE "key" = 'content.create')
ON CONFLICT ("key") DO NOTHING;

ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permission" ("roleId", "permissionId")
SELECT r."id", templates_manage."id"
  FROM "role" r
  JOIN "permission" templates_manage ON templates_manage."key" = 'templates.manage'
 WHERE r."key" IN ('workspace_owner', 'workspace_admin', 'marketing_manager', 'designer')
   AND r."realm" = 'WORKSPACE'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = '"role"'::regclass
       AND relrowsecurity IS TRUE
       AND relforcerowsecurity IS TRUE
  ) THEN
    RAISE EXCEPTION 'role must have RLS ENABLED and FORCED after this migration';
  END IF;
END $$;

COMMIT;
