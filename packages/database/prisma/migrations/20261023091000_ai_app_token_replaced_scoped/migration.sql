-- Connected AI apps — the rotation link stays inside one workspace (D-566, D-568).
--
-- 20261023090000_ai_app_connections linked a rotated refresh token to its
-- successor with a plain single-column key ("replacedById" -> "id"). D-112
-- forbids that between tenant-owned rows: the key is checked without RLS, so
-- the database itself must keep both ends in the same workspace. This makes
-- the key composite on "workspaceId". The SQL was sent to the owner as written
-- and approved ("fix it") on 2026-10-19.
--
-- Behaviour is unchanged: when the sweep deletes the successor, only
-- "replacedById" becomes NULL (PostgreSQL 15+ column list), so the old row —
-- and with it the reuse check — stays until its own expiry.
--
-- FORWARD-ONLY. No row, policy or grant changes.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- D-112: the rotation link stays inside one workspace, enforced by the database.
CREATE UNIQUE INDEX "ai_app_token_workspaceId_id_key" ON "ai_app_token" ("workspaceId", "id");

ALTER TABLE "ai_app_token" DROP CONSTRAINT "ai_app_token_replaced_fkey";

ALTER TABLE "ai_app_token" ADD CONSTRAINT "ai_app_token_replaced_fkey"
  FOREIGN KEY ("workspaceId", "replacedById")
  REFERENCES "ai_app_token"("workspaceId", "id")
  ON DELETE SET NULL ("replacedById") ON UPDATE CASCADE;

-- Proof: the key is composite on the workspace, and RLS is still forced.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_app_token_replaced_fkey' AND conrelid = 'public.ai_app_token'::regclass
       AND array_length(conkey, 1) = 2
  ) THEN
    RAISE EXCEPTION 'ai apps: ai_app_token_replaced_fkey is not composite';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.ai_app_token'::regclass
                   AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'ai apps: RLS not forced on ai_app_token';
  END IF;
END $$;

COMMIT;
