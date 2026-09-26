-- Q12 (prototype v90), SECOND RELEASE: the Viewer reads content.
--
-- Phase 2A (`20260926090000_notes_manage_permission`) moved every privileged
-- note action behind `notes.manage` and shipped the read-only Content,
-- Approvals and comment-only notes paths for a Viewer who holds
-- `content.read`, without granting it. This migration grants it. It must deploy
-- only after Phase 2A is live, never together with it and never before it.
--
-- WHAT IT GRANTS: `content.read` to `client_viewer`, and nothing else. Not
-- `notes.manage`, not any content mutation, not publishing, `copilot.use`,
-- credits or campaigns.
--
-- EVERY `client_viewer` ROW, NOT ONE. `role.workspaceId` is nullable and the
-- unique key is (`workspaceId`, `key`), so two kinds of row can carry the key:
--   * the SYSTEM role, `workspaceId IS NULL`, written by the seed and the
--     bootstrap commands from `ROLE_DEFINITIONS` (NULLs are distinct in a
--     unique index, so nothing in the schema limits it to one row);
--   * a WORKSPACE-SCOPED role, `workspaceId = <workspace>`, which the schema,
--     the `role` RLS policy and the D-112 trigger all permit as a custom role.
-- The grant matches on the key alone, so it reaches both kinds. It is limited
-- to the WORKSPACE realm because `content.read` is a workspace permission and
-- permissions and roles never cross realms.
--
-- DATA ONLY, ADDITIVE, IDEMPOTENT.
--   - It inserts `role_permission` rows and never updates or deletes one.
--     `ON CONFLICT DO NOTHING`, so re-running it changes nothing.
--   - It creates no role and no permission. On a freshly migrated, EMPTY
--     database there is no role and no permission to join, so it inserts
--     nothing; the seed or the bootstrap then writes the whole catalogue from
--     `ROLE_DEFINITIONS`, this grant included
--     (`tests/isolation/bootstrap-production-owner.test.ts`).
--   - SAFE WHILE THE PREVIOUS RELEASE IS LIVE. Phase 2A already reads
--     `content.read` for the Viewer's paths and already refuses every note
--     mutation without `notes.manage`, so the grant only opens paths that
--     release was built to serve. No table changes shape.
--
-- READING `role` NEEDS FORCE LIFTED. `role_permission` and `permission` are
-- global catalogue tables without row-level security, but `role` is ENABLE +
-- FORCE RLS and has no policy for the migrator: under FORCE the SELECT below
-- would see ZERO roles and the grant would silently do nothing. FORCE is lifted
-- inside this transaction only, restored before COMMIT and asserted — the same
-- pattern as `20260915235000_d112_role_reference_is_workspace_scoped`.

BEGIN;

ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_permission" ("roleId", "permissionId")
SELECT viewer."id", content_read."id"
  FROM "role" viewer
  JOIN "permission" content_read ON content_read."key" = 'content.read'
 WHERE viewer."key" = 'client_viewer'
   AND viewer."realm" = 'WORKSPACE'
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
