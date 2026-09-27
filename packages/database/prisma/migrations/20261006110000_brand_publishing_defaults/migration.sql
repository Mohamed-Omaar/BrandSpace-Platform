-- Prototype v90 Phase 2B-2, A8 / A10 / B2: a brand's publishing defaults and
-- its AI suggestions switch.
--
-- SCHEMA ONLY, ADDITIVE. Four columns on "brand", each with a constant default
-- (so PostgreSQL adds them without rewriting the table), and two CHECKs. No row
-- is updated: every existing brand starts with no default channels, no default
-- time, hashtags in the caption and AI suggestions on — exactly how the product
-- behaves today.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. That release never reads or writes
-- these columns, and its brand inserts get the defaults.

ALTER TABLE "brand" ADD COLUMN     "aiSuggestionsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "defaultPlatformKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "defaultPostTime" TEXT,
ADD COLUMN     "hashtagsInFirstComment" BOOLEAN NOT NULL DEFAULT false;

-- A local clock time, `HH:mm`, or nothing.
ALTER TABLE "brand"
  ADD CONSTRAINT "brand_default_post_time_shape"
  CHECK ("defaultPostTime" IS NULL OR "defaultPostTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT "brand_default_platform_keys_bounded"
  CHECK (coalesce(cardinality("defaultPlatformKeys"), 0) <= 20);
