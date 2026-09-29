-- PHASE 2C-3 (M5) — `content_knowledge_usage`: which Brand Brain facts, at
-- which VERSION, AI writing actually used for a content variant (D9), and a
-- dismissed change per use (D10 "Keep as is").
--
-- SCHEMA ONLY, ADDITIVE. One new tenant-owned, brand-scoped table with ENABLE +
-- FORCE RLS, the standard `tenant_isolation` / `platform_access` policies and
-- grants, composite foreign keys (D-99), bounds, and a scope trigger. No row
-- is inserted: no customer data, no sample data, NO BACKFILL — a post written
-- before this release has no recorded usage and shows none; nothing is
-- inferred from caption text or `content_item.citations`.
--
-- A ROW IS WRITTEN ONLY FROM WHAT THE GROUNDING LAYER RETURNED AND THE PROMPT
-- CARRIED (`Grounding.facts`: item id + version), in the same transaction as
-- the generated caption. The CURRENT set of a variant is its rows with
-- `supersededAt IS NULL`; the next AI generation of that variant supersedes
-- them (history is kept, never deleted).
--
-- THE VERSION IS THE INTEGER THE PROMPT CARRIED, kept on the row. Editing or
-- archiving the fact later only ADDS versions to the append-only history, so
-- the recorded version's text stays readable there. It is deliberately NOT a
-- foreign key into `brand_knowledge_version`: a fact whose history lacks a row
-- (seeded or imported data) must never make a caption fail to save.
--
-- DELETION: the rows follow their variant, item, fact, brand and workspace
-- (ON DELETE CASCADE). Knowledge is archived, never deleted, and a content
-- item's soft delete (`deletedAt`) leaves its rows in place — readers exclude
-- deleted posts — until the purge removes the item and, with it, its rows.
--
-- THE PREVIOUS RELEASE neither reads nor writes this table. An application
-- rollback leaves it unused; ROLLBACK of the schema is by a forward migration.

CREATE TABLE "content_knowledge_usage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "contentItemId" UUID NOT NULL,
    "contentVariantId" UUID NOT NULL,
    "knowledgeItemId" UUID NOT NULL,
    "knowledgeVersion" INTEGER NOT NULL,
    "aiRequestId" UUID,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMPTZ(6),
    "dismissedChangeSignature" TEXT,
    "dismissedByUserId" UUID,
    "dismissedAt" TIMESTAMPTZ(6),

    CONSTRAINT "content_knowledge_usage_pkey" PRIMARY KEY ("id")
);

-- ONE CURRENT USE OF A FACT PER VARIANT. History (superseded rows) is unbounded.
CREATE UNIQUE INDEX "content_knowledge_usage_current_key"
  ON "content_knowledge_usage" ("contentVariantId", "knowledgeItemId")
  WHERE "supersededAt" IS NULL;
-- A variant's current set (Studio, D10).
CREATE INDEX "content_knowledge_usage_workspaceId_contentVariantId_supers_idx"
  ON "content_knowledge_usage" ("workspaceId", "contentVariantId", "supersededAt");
-- "Used in N posts" and D10 across a brand: the current uses of a fact.
CREATE INDEX "content_knowledge_usage_current_by_fact_idx"
  ON "content_knowledge_usage" ("workspaceId", "brandId", "knowledgeItemId")
  WHERE "supersededAt" IS NULL;
CREATE INDEX "content_knowledge_usage_workspaceId_contentItemId_idx"
  ON "content_knowledge_usage" ("workspaceId", "contentItemId");

ALTER TABLE "content_knowledge_usage" ADD CONSTRAINT "content_knowledge_usage_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- COMPOSITE (D-99, D-112), so every parent is reached only inside its own
-- workspace: referential integrity runs with RLS bypassed, and a bare id would
-- answer "does this row exist?" across the tenant boundary.
ALTER TABLE "content_knowledge_usage" ADD CONSTRAINT "content_knowledge_usage_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_knowledge_usage" ADD CONSTRAINT "content_knowledge_usage_item_fkey"
  FOREIGN KEY ("workspaceId", "contentItemId") REFERENCES "content_item"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "content_knowledge_usage" ADD CONSTRAINT "content_knowledge_usage_variant_fkey"
  FOREIGN KEY ("workspaceId", "contentVariantId") REFERENCES "content_variant"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "content_knowledge_usage" ADD CONSTRAINT "content_knowledge_usage_knowledge_fkey"
  FOREIGN KEY ("workspaceId", "knowledgeItemId") REFERENCES "brand_knowledge_item"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "content_knowledge_usage"
  ADD CONSTRAINT "content_knowledge_usage_version_positive"
    CHECK ("knowledgeVersion" >= 1),
  -- A dismissal is one fact: which change, who, when — all three or none.
  ADD CONSTRAINT "content_knowledge_usage_dismissal_complete"
    CHECK (
      ("dismissedChangeSignature" IS NULL AND "dismissedByUserId" IS NULL AND "dismissedAt" IS NULL)
      OR ("dismissedChangeSignature" IS NOT NULL AND "dismissedByUserId" IS NOT NULL AND "dismissedAt" IS NOT NULL)
    ),
  -- sha256, lowercase hex.
  ADD CONSTRAINT "content_knowledge_usage_signature_shape"
    CHECK ("dismissedChangeSignature" IS NULL OR "dismissedChangeSignature" ~ '^[0-9a-f]{64}$');

-- A USE BELONGS TO ONE POST OF ONE BRAND, AND TO A FACT OF THAT BRAND. The
-- composite keys prove the workspace; they cannot prove that the variant is a
-- variant of this item, or that the item and the fact are this brand's. Like
-- the sibling scope triggers it is NOT `SECURITY DEFINER`, so RLS applies to
-- the lookups.
CREATE OR REPLACE FUNCTION content_knowledge_usage_is_in_scope()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "content_variant" v
    JOIN "content_item" i ON i."workspaceId" = v."workspaceId" AND i."id" = v."contentItemId"
    WHERE v."workspaceId" = NEW."workspaceId"
      AND v."id" = NEW."contentVariantId"
      AND v."contentItemId" = NEW."contentItemId"
      AND i."brandId" = NEW."brandId"
  ) THEN
    RAISE EXCEPTION 'a knowledge use must name a variant of its own content item and brand'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "brand_knowledge_item" k
    WHERE k."workspaceId" = NEW."workspaceId"
      AND k."id" = NEW."knowledgeItemId"
      AND k."brandId" = NEW."brandId"
  ) THEN
    RAISE EXCEPTION 'a knowledge use must name a fact of the same brand'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_knowledge_usage_scope
  BEFORE INSERT OR UPDATE OF "contentVariantId", "contentItemId", "knowledgeItemId", "brandId"
  ON "content_knowledge_usage"
  FOR EACH ROW EXECUTE FUNCTION content_knowledge_usage_is_in_scope();

ALTER TABLE "content_knowledge_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "content_knowledge_usage" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "content_knowledge_usage"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "content_knowledge_usage"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "content_knowledge_usage" TO brandspace_app, brandspace_platform;

-- REFUSE TO COMMIT A HALF-APPLIED VERSION (the F-80 precedent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'content_knowledge_usage_scope' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'the knowledge-usage scope trigger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'content_knowledge_usage' AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'content_knowledge_usage must ENABLE and FORCE ROW LEVEL SECURITY';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'content_knowledge_usage_current_key'
  ) THEN
    RAISE EXCEPTION 'the one-current-use-per-fact index is missing';
  END IF;
END $$;
