-- PR B (brand-aware images; D-601, D-602). SQL approved by the owner on
-- 2026-11-14.
--
-- SCHEMA ONLY, ADDITIVE. Two columns on "creative_generation_job" and one
-- CHECK; nothing is backfilled. Every existing row gets "addLogo" = true (the
-- owner's default) and a NULL headline. No RLS change: the table keeps its
-- existing tenant_isolation / platform_access policies (FORCE RLS), which
-- cover every column of the row.
--
-- WHAT IT HOLDS. What the person chose to put on the made image, so a run
-- that happens later — or the recovery sweep's re-run — uses exactly that:
-- whether the brand's real logo is placed, and an optional short headline.
-- The headline is customer content: it is deleted with the job on the
-- workspace's AI-content retention schedule, like the brief
-- (`CreativeGenerationJobs.purgeExpired`).
--
-- ROLLBACK: a previous release ignores both columns.

ALTER TABLE "creative_generation_job" ADD COLUMN "addLogo" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "creative_generation_job" ADD COLUMN "headline" TEXT;
ALTER TABLE "creative_generation_job" ADD CONSTRAINT "creative_generation_job_headline_length"
  CHECK ("headline" IS NULL OR char_length("headline") BETWEEN 1 AND 80);
