-- Prototype v94 Phase 2B-1, A9 (D-330): the General settings' own fields.
--
-- SCHEMA ONLY, ADDITIVE. Two NULLABLE columns on "workspace" and two CHECK
-- constraints. Nothing is backfilled and no row is inserted, updated or
-- deleted, so a freshly migrated EMPTY database stays empty.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. That release neither reads nor
-- writes these columns; every existing row gets NULL, which means "no city"
-- and "the configured week start" — exactly what it shows today. Both CHECKs
-- hold for every existing row (NULL passes each), so adding them validates
-- instantly. The one write of the previous release they could refuse is a
-- Control Center country change away from Egypt on a workspace the NEW release
-- has already given a city — impossible before the new release runs, and
-- during a rollback it is refused with an error, never stored inconsistently.
--
-- ROLLBACK is by a forward migration (drop the columns), never by replaying or
-- editing this file.

ALTER TABLE "workspace" ADD COLUMN     "city" TEXT,
ADD COLUMN     "weekStartsOn" INTEGER;

-- A city is an Egyptian governorate code, and only for an Egyptian workspace.
ALTER TABLE "workspace"
  ADD CONSTRAINT "workspace_city_egypt_only"
  CHECK ("city" IS NULL OR ("country" = 'EG' AND "city" ~ '^EG-[A-Z]{1,3}$'));

-- A weekday: 0 = Sunday … 6 = Saturday.
ALTER TABLE "workspace"
  ADD CONSTRAINT "workspace_week_starts_on_range"
  CHECK ("weekStartsOn" IS NULL OR "weekStartsOn" BETWEEN 0 AND 6);
