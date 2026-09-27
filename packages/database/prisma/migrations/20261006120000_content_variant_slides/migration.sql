-- Prototype v90 Phase 2B-2, B9: one short headline per carousel slide.
--
-- SCHEMA ONLY, ADDITIVE. One nullable JSONB column on "content_variant" and
-- one CHECK on its shape. No row is written: every existing variant keeps
-- NULL, which means "no slide headlines" — and the approval fingerprint only
-- includes slides when a variant has some, so no existing approval changes
-- meaning (packages/shared/src/content-fingerprint.ts).
--
-- WHY A COLUMN AND NOT A `content_slide` TABLE (Phase 2B-2 report): slides are
-- always read and written with their variant, inherit its RLS, its read-only
-- and edit-in-review guards and its duplicate path, and join its approval
-- fingerprint in one place. A table would add a tenant surface for none of
-- that.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. That release never reads or writes
-- this column.

ALTER TABLE "content_variant" ADD COLUMN     "slides" JSONB;

-- An array (at most 20 slides) or nothing; the service validates each entry.
ALTER TABLE "content_variant"
  ADD CONSTRAINT "content_variant_slides_is_bounded_array"
  CHECK ("slides" IS NULL OR (jsonb_typeof("slides") = 'array' AND jsonb_array_length("slides") <= 20));
