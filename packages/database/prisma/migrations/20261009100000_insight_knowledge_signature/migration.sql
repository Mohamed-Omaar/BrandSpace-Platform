-- PHASE 2C-4 (M7) — the Brand Brain signature a strategy was generated on (D13).
--
-- SCHEMA ONLY, ADDITIVE. One nullable column on `insight`. No row is inserted
-- or updated: no customer data, no sample data, NO BACKFILL.
--
-- WHAT IT HOLDS. Lowercase hex SHA-256 over the brand's USABLE facts as sorted
-- `itemId:version` pairs (the grounding layer's own usable rule, today in the
-- workspace's time zone), written by the Strategy engine when it generates a
-- STRATEGY or MONTHLY_PLAN insight. The Strategy page compares it with the
-- current signature and says "Brand Brain changed" only when they differ.
--
-- NULL MEANS NO BASELINE. Every insight that exists before this release, and
-- every other insight type, is NULL, and a NULL signature never raises the
-- alert: there is nothing to compare with.
--
-- THE PREVIOUS RELEASE neither reads nor writes the column: an application
-- rollback leaves it NULL on new rows and ignored on old ones. Rolling the
-- schema back is dropping the column, which loses only these baselines.

ALTER TABLE "insight" ADD COLUMN "knowledgeSignature" TEXT;
