-- D-112 for the one relationship a composite foreign key cannot express.
--
-- `membership."roleId"` and `invitation."roleId"` reference `role(id)` by id
-- alone. `role` is tenant-owned with a NULLABLE tenant key — a system role has
-- `workspaceId IS NULL` and is shared by every workspace, a custom role belongs
-- to exactly one — so the composite key the other four relationships got is not
-- available here: a child whose `workspaceId` is NOT NULL can never match a
-- parent row whose `workspaceId` IS NULL.
--
-- WHAT WAS ACTUALLY WRONG. The application already enforces the right rule
-- (`packages/auth/src/invitations.ts`: "A workspace-scoped custom role may only
-- be used by its own workspace"), and the audit confirmed that path refuses.
-- The DATABASE did not: from inside workspace B, an invitation naming workspace
-- A's custom role was ACCEPTED. CLAUDE.md §2.1 requires two independent layers
-- and only one was holding, so this is a defence-in-depth gap rather than a
-- reachable exploit — but permissions resolve straight through
-- `membership.roleId`, so the thing the missing layer was protecting is the
-- permission set itself.
--
-- WHY A TRIGGER AND NOT `SECURITY DEFINER`. The trigger reads `role` as the
-- INVOKER, which is deliberate and makes the check correct in both realms:
--
--   * In a tenant context, `role`'s own RLS policy is already exactly this
--     rule — `"workspaceId" IS NULL OR "workspaceId" = app.current_workspace_id()`
--     — so another workspace's custom role is simply NOT VISIBLE and the
--     lookup finds nothing. Refusing on "not found" IS the tenancy check.
--   * In a platform context every role is visible, so the explicit comparison
--     below is what refuses a cross-wired write.
--
-- A system role is visible under both policies, so workspace provisioning —
-- which creates the first owner membership against a system role — is
-- unaffected. That is the flow most at risk from a trigger here, and it is the
-- one this formulation deliberately leaves alone.

CREATE OR REPLACE FUNCTION app.role_reference_is_workspace_scoped() RETURNS trigger AS $$
DECLARE role_workspace UUID;
        role_found     BOOLEAN;
BEGIN
  SELECT r."workspaceId", TRUE
    INTO role_workspace, role_found
    FROM "role" r
   WHERE r."id" = NEW."roleId";

  IF role_found IS NOT TRUE THEN
    RAISE EXCEPTION
      'role % is not available to workspace %', NEW."roleId", NEW."workspaceId"
      USING ERRCODE = '23503';
  END IF;

  -- NULL is a SYSTEM role and belongs to everyone. Anything else must match.
  IF role_workspace IS NOT NULL AND role_workspace <> NEW."workspaceId" THEN
    RAISE EXCEPTION
      'role % belongs to another workspace', NEW."roleId"
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION app.role_reference_is_workspace_scoped() IS
  'D-112: a membership or invitation may only name a system role or a role of its own workspace.';

DROP TRIGGER IF EXISTS membership_role_is_workspace_scoped ON "membership";
CREATE TRIGGER membership_role_is_workspace_scoped
  BEFORE INSERT OR UPDATE OF "roleId", "workspaceId" ON "membership"
  FOR EACH ROW EXECUTE FUNCTION app.role_reference_is_workspace_scoped();

DROP TRIGGER IF EXISTS invitation_role_is_workspace_scoped ON "invitation";
CREATE TRIGGER invitation_role_is_workspace_scoped
  BEFORE INSERT OR UPDATE OF "roleId", "workspaceId" ON "invitation"
  FOR EACH ROW EXECUTE FUNCTION app.role_reference_is_workspace_scoped();
