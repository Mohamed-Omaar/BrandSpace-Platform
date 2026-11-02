-- P1 item 2: each person's own light / dark / device choice, stored server-side.
-- SQL approved by the owner on 2026-11-02, as written.
-- SCHEMA ONLY, ADDITIVE: one NULLABLE column with a CHECK. NULL = "no choice",
-- which falls back to the Look & feel default. Nothing is backfilled. No RLS
-- change: "user" keeps its existing policies (a person writes only their own
-- row, outside any workspace context, exactly as locale and MFA already do).
ALTER TABLE "user" ADD COLUMN "colorScheme" TEXT;
ALTER TABLE "user" ADD CONSTRAINT "user_color_scheme_value"
  CHECK ("colorScheme" IS NULL OR "colorScheme" IN ('light', 'dark', 'system'));
