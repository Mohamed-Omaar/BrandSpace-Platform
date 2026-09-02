-- ===========================================================================
-- Phase 2A — close the Platform Admin credential exposure on "platform_user".
--
-- Finding (discovered while writing the Phase 2A platform-role tests):
--   The identity migration created "platform_user" and the RLS migration then
--   granted the tenant application role every privilege on ALL TABLES IN SCHEMA
--   public. "platform_user" was never given a policy, so it inherited the
--   permissive default: brandspace_app could
--
--       SELECT id, email, "passwordHash", "mfaSecretRef" FROM platform_user;
--
--   i.e. any code path reachable from a customer request — including a single
--   SQL-injection defect in a tenant query — could read the Platform Owner's
--   Argon2id password hash and the reference to their TOTP secret. That is a
--   direct contradiction of "Do not expose Platform Admin authentication to
--   customer sessions" (CLAUDE.md §1, docs/SECURITY.md).
--
-- "platform_user" is platform-owned, exactly like the tables added in
-- 20260901194148_platform_admin_config_secrets, and is brought under the same
-- two independent controls:
--
--   1. GRANTs: every privilege revoked from brandspace_app.
--   2. RLS: ENABLEd and FORCEd with a policy naming brandspace_platform only,
--      so a future blanket GRANT still yields zero rows.
--
-- Foreign keys from tenant-reachable tables ("support_mode_session",
-- "audit_event" actor references) keep working: PostgreSQL referential-integrity
-- checks run with the privileges of the referenced table's owner and are exempt
-- from RLS, so revoking the tenant role's SELECT does not break them.
-- ===========================================================================

ALTER TABLE "platform_user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_user" FORCE  ROW LEVEL SECURITY;

CREATE POLICY platform_only ON "platform_user"
  TO brandspace_platform USING (true) WITH CHECK (true);

REVOKE ALL ON "platform_user" FROM brandspace_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_user" TO brandspace_platform;
