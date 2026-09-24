-- PHASE 6 FINAL · D-277 — ENGLISH IS THE DEFAULT, NOT ARABIC.
--
-- Two column defaults still encoded the D-03 Arabic default. Every service
-- passes an explicit value today, so these fire only when a writer omits one —
-- and an omission must now mean English, the platform default, rather than
-- silently Arabic. Existing rows are untouched: a default changes what a FUTURE
-- insert gets, never what a stored row says.

ALTER TABLE "content_item" ALTER COLUMN "primaryLocale" SET DEFAULT 'EN';
ALTER TABLE "email_message" ALTER COLUMN "locale" SET DEFAULT 'EN';
