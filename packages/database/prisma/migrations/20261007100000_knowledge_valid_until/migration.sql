-- Prototype v90 Phase 2C, item 2: "valid until" on Brand Brain facts (D6) and
-- the link from an archived fact to the fact that replaced it (D4).
--
-- SCHEMA ONLY, ADDITIVE. Three nullable columns, one composite foreign key, one
-- CHECK and one index. No row is updated or inserted: every existing fact has no
-- end date (valid indefinitely) and was replaced by nothing, which is exactly
-- how the product treats it today.
--
-- "validUntil" IS A DATE, NOT A TIMESTAMP. It is a local calendar day in the
-- workspace's time zone; the application decides "expired" by comparing it with
-- today's date in that zone, so a later time-zone change (Q22) never moves it.
--
-- THE FOREIGN KEY FOLLOWS F-80 / F-83 (D-112): composite on
-- ("workspaceId", "supersededByItemId") against the item's (workspaceId, id)
-- unique, so it can never name — or reveal the existence of — another tenant's
-- fact, and column-scoped SET NULL so a parent delete never touches the tenant
-- key.
--
-- RLS AND GRANTS: unchanged. Both tables stay under their tenant policies; the
-- version table stays append-only (its triggers and the runtime role's missing
-- UPDATE/DELETE grants are untouched — a new nullable column is set on INSERT).
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. That release never reads or writes
-- these columns. ROLLBACK NOTE: if the application is rolled back after facts
-- were given an end date, the previous release ignores "validUntil", so an
-- EXPIRED fact would ground writing again until this release returns (release
-- note; D-356).

ALTER TABLE "brand_knowledge_item"
  ADD COLUMN "validUntil" DATE,
  ADD COLUMN "supersededByItemId" UUID;

ALTER TABLE "brand_knowledge_version"
  ADD COLUMN "validUntil" DATE;

ALTER TABLE "brand_knowledge_item"
  ADD CONSTRAINT "brand_knowledge_item_superseded_fkey"
  FOREIGN KEY ("workspaceId", "supersededByItemId")
  REFERENCES "brand_knowledge_item"("workspaceId", "id")
  ON DELETE SET NULL ("supersededByItemId") ON UPDATE NO ACTION;

-- A fact cannot replace itself.
ALTER TABLE "brand_knowledge_item"
  ADD CONSTRAINT "brand_knowledge_item_not_superseded_by_itself"
  CHECK ("supersededByItemId" IS NULL OR "supersededByItemId" <> "id");

CREATE INDEX "brand_knowledge_item_workspaceId_brandId_validUntil_idx"
  ON "brand_knowledge_item"("workspaceId", "brandId", "validUntil");
