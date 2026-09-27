-- Prototype v94 Phase 2B-1, G4 / Q23 (D-333): the Owner can require two-step
-- verification for the workspace, and a person can move it to a new phone.
--
-- SCHEMA ONLY, ADDITIVE. One NOT NULL boolean with a constant default on
-- "workspace", and one NULLABLE JSONB column on "user". Nothing is backfilled
-- and no row is inserted, updated or deleted, so a freshly migrated EMPTY
-- database stays empty. A constant default is stored in the catalogue, not
-- written into every row, so adding it does not rewrite the table.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. That release neither reads nor
-- writes either column. Every existing workspace gets `false` — "not required"
-- — which is exactly what every workspace is today, and every person gets NULL
-- — "no new phone being set up".
--
-- ROLLBACK is by a forward migration (drop the columns), never by replaying or
-- editing this file.

ALTER TABLE "workspace" ADD COLUMN "requireMfa" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "user" ADD COLUMN "mfaPendingSecretMaterial" JSONB;
