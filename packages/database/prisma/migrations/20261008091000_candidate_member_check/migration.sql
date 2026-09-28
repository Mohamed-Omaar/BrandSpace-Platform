-- PHASE 2C-3 (M4b) — who proposed a MEMBER candidate, and what a MEMBER
-- candidate must (and must not) carry.
--
-- SCHEMA ONLY, ADDITIVE. One nullable column and a CHECK replaced by a wider
-- one. No row is inserted, updated or rewritten: no customer data, no sample
-- data, no backfill. Existing DOCUMENT and ANALYTICS rows satisfy the new CHECK
-- exactly as they satisfied the old one (their branches are unchanged), so the
-- constraint validates against the rows already there.
--
-- `proposedByUserId` follows its siblings on this table (`reviewedByUserId`)
-- and on `brand_knowledge_item` (`createdByUserId`): an actor id, recorded,
-- with no foreign key to the identity table, so removing a person never
-- rewrites the history of what they proposed.
--
-- RLS AND GRANTS: unchanged. The table is already under its tenant policy and
-- the runtime roles' table-level grants cover a new column.
--
-- NOT A SIMPLE ROLLBACK — see M4a and docs/OPERATIONS.md §6.6. The column and
-- the CHECK are harmless to the previous release (it never sets the column and
-- never writes MEMBER); a MEMBER ROW written by the new release is what the
-- previous release cannot decode.

ALTER TABLE "brand_knowledge_candidate" ADD COLUMN "proposedByUserId" UUID;

-- A DOCUMENT candidate still has a document and an ANALYTICS candidate still
-- has an insight (Phase 7). A MEMBER candidate has NEITHER — it came from a
-- person, not a file or a measurement — and must say who proposed it.
ALTER TABLE "brand_knowledge_candidate"
  DROP CONSTRAINT "brand_knowledge_candidate_source_is_present";

ALTER TABLE "brand_knowledge_candidate"
  ADD CONSTRAINT "brand_knowledge_candidate_source_is_present"
  CHECK (
    ("sourceKind" = 'DOCUMENT'  AND "sourceDocumentId" IS NOT NULL)
    OR ("sourceKind" = 'ANALYTICS' AND "insightId" IS NOT NULL)
    OR (
      "sourceKind" = 'MEMBER'
      AND "sourceDocumentId" IS NULL
      AND "insightId" IS NULL
      AND "proposedByUserId" IS NOT NULL
    )
  );

-- REFUSE TO COMMIT A HALF-APPLIED VERSION (the F-80 precedent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'brand_knowledge_candidate_source_is_present'
      AND pg_get_constraintdef(oid) LIKE '%MEMBER%'
  ) THEN
    RAISE EXCEPTION 'the MEMBER branch of the candidate source CHECK is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'brand_knowledge_candidate' AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'brand_knowledge_candidate must keep FORCE ROW LEVEL SECURITY';
  END IF;
END $$;
