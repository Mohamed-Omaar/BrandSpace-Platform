-- ---------------------------------------------------------------------------
-- F-80 AND F-83 — EVERY BRAND BRAIN FOREIGN KEY THAT WAS A CROSS-TENANT
-- EXISTENCE ORACLE.
--
-- Phase 5A shipped EIGHT foreign keys that reference a tenant-owned parent BY
-- ID ALONE:
--
--   F-80, recorded:
--     brand_source_chunk."sourceDocumentId"        -> brand_source_document(id)
--     brand_ingestion_job."sourceDocumentId"       -> brand_source_document(id)
--     brand_brain_message."conversationId"         -> brand_brain_conversation(id)
--
--   F-83, found by querying the catalogue for the whole module rather than the
--   four tables F-80 happened to name:
--     brand_knowledge_candidate."sourceDocumentId" -> brand_source_document(id)
--     brand_knowledge_candidate."targetItemId"     -> brand_knowledge_item(id)
--     brand_knowledge_item."sourceDocumentId"      -> brand_source_document(id)
--     brand_knowledge_item."conflictsWithItemId"   -> brand_knowledge_item(id)
--     brand_knowledge_version."knowledgeItemId"    -> brand_knowledge_item(id)
--
-- WHY THAT IS A LEAK AND NOT AN UNTIDINESS. PostgreSQL evaluates referential
-- integrity with ROW-LEVEL SECURITY BYPASSED — the check runs as the table
-- owner, not as the caller. A plain `sourceDocumentId` therefore ACCEPTS
-- another workspace's document id: the row lands carrying its OWN workspaceId,
-- so the RLS policy is satisfied and nothing else objects. And even where a
-- write is refused, the difference between "inserted" and "constraint
-- violated" answers the question *does this id exist somewhere on the
-- platform?* — which is exactly the inference CLAUDE.md §2.1 forbids, and the
-- reason it says a cross-tenant miss must be shaped identically to a genuine
-- one. Probed directly against the test database; all eight confirmed.
--
-- THE FIX IS THE ONE THE ASSET LIBRARY ALREADY USES (D-99, generalised to the
-- whole platform as D-112). Each key becomes composite on
-- `(workspaceId, <parent id>)` against a `(workspaceId, id)` unique on the
-- parent. The oracle collapses from "does this id exist anywhere" to "is this
-- a row in MY OWN workspace", which discloses nothing a caller did not already
-- have. The referenced row becomes INVISIBLE rather than merely unusable.
--
-- REFERENTIAL ACTIONS ARE PRESERVED EXACTLY. Each key keeps the ON DELETE it
-- had — CASCADE where it cascaded, SET NULL where it nulled — so nothing about
-- the product's deletion behaviour changes. §4 explains the one place where
-- keeping SET NULL required saying more than `ON DELETE SET NULL`.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO. It drops no column, rewrites
-- no row, and deletes nothing. Every valid row survives it untouched. The only
-- destructive statement available here would be to remove rows that violate
-- the new constraints, and that is precisely the thing a migration must never
-- decide on its own: the pre-flight REFUSES rather than repairs, and names the
-- relationship and the count so an operator can look before anything is lost.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0. ONE TRANSACTION, EXPLICITLY.
--
-- PRISMA DOES NOT WRAP A MIGRATION FILE IN A TRANSACTION — it applies the
-- statements one at a time, which is what lets
-- `20260902200000_phase_2b_customers_workspaces` add an enum value and then use
-- it in the same file. Atomicity here therefore has to be asked for, and this
-- migration genuinely needs it: §1 below lifts a protection that §5 restores,
-- and those two must be inseparable.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. MAKE THE MIGRATOR ABLE TO SEE WHAT IT IS VALIDATING.
--
-- READ THIS BEFORE CONCLUDING THAT IT WEAKENS ANYTHING. It does not, and
-- omitting it would produce a migration that LIES.
--
-- These eight tables are `FORCE ROW LEVEL SECURITY` with policies for
-- `brandspace_app` and `brandspace_platform` only. FORCE means the TABLE OWNER
-- is subject to RLS too, and the owner is `brandspace_migrator` — the role
-- Prisma runs migrations as. No policy names it, so the default deny applies
-- and the migrator sees ZERO ROWS in all eight tables.
--
-- Two consequences, both measured rather than reasoned about:
--
--   a. A pre-flight anti-join run as the migrator returns 0 offending rows
--      NO MATTER HOW MANY THERE ARE. A check that cannot fail is not a check.
--
--   b. Worse — `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` validates only the
--      rows the current role can see, and then marks the constraint
--      `convalidated = true`. The migration would report success, the
--      catalogue would claim the data satisfies the key, and the offending
--      rows would still be sitting underneath it. PostgreSQL enforces the key
--      on every FUTURE write and never revisits the past.
--
-- So FORCE is lifted for the duration of this transaction and restored in §5.
-- NO OTHER SESSION CAN OBSERVE THE LIFTED STATE: `ALTER TABLE` takes an ACCESS
-- EXCLUSIVE lock on each table and holds it until COMMIT, which excludes every
-- other reader and writer for exactly the interval in which FORCE is off. If
-- anything below fails, ROLLBACK restores the catalogue along with everything
-- else. §6 then asserts FORCE is back on rather than assuming it.
--
-- This is PostgreSQL's own prescribed remedy: attempting the same read with
-- `SET LOCAL row_security = off` fails with
-- `HINT: To disable the policy for the table's owner, use ALTER TABLE NO FORCE
-- ROW LEVEL SECURITY.`
--
-- ENABLE ROW LEVEL SECURITY is NOT touched. The policies are NOT touched. The
-- application and platform roles are unaffected throughout. The append-only
-- layers on `brand_knowledge_version` are untouched: no GRANT is issued, and
-- its trigger is neither dropped nor disabled — `ALTER TABLE ... ADD
-- CONSTRAINT` does not fire row triggers.
-- ---------------------------------------------------------------------------

ALTER TABLE "brand_source_document"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_source_chunk"         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_ingestion_job"        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_conversation"   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_message"        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_item"       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_version"    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_candidate"  NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. PRE-FLIGHT. FAIL, DO NOT REPAIR.
--
-- A RAISE here aborts the transaction opened above and leaves the database
-- exactly as it was. The message carries the relationship and a COUNT — never
-- an id, a workspace or any row content: a migration log is not a place
-- customer data belongs, and the operator who needs the rows can run the same
-- anti-join themselves.
--
-- IT ALSO HAS TO COME BEFORE THE CONSTRAINTS FOR A SECOND REASON. PostgreSQL's
-- own foreign-key violation on `ADD CONSTRAINT` is perfectly capable of
-- catching these rows now that §1 has made them visible — but its DETAIL line
-- prints the offending key, which here is a workspace id and a document id.
-- Refusing first means the failure an operator actually sees carries counts and
-- no identifiers.
--
-- Each anti-join catches both failure modes at once. A row whose parent is in
-- ANOTHER workspace fails to match, and so does a row whose parent does not
-- exist at all — the second is impossible under the plain keys being replaced,
-- and is checked anyway because "impossible" is an assumption and this is the
-- one moment it can be verified for free.
--
-- THE NULLABLE COLUMNS ARE FILTERED, NOT JOINED BLINDLY. PostgreSQL's default
-- MATCH SIMPLE satisfies a composite key whenever ANY referencing column is
-- NULL, so a candidate that proposes something new (`targetItemId IS NULL`), an
-- item with no source document, and an item in no conflict are all exempt BY
-- CONSTRUCTION. Counting them as offending would refuse a migration over rows
-- the constraint will happily accept.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad_chunks     bigint;
  bad_jobs       bigint;
  bad_messages   bigint;
  bad_cand_doc   bigint;
  bad_cand_item  bigint;
  bad_item_doc   bigint;
  bad_item_confl bigint;
  bad_versions   bigint;
  offending      text;
BEGIN
  -- F-80.
  SELECT count(*) INTO bad_chunks
  FROM "brand_source_chunk" c
  LEFT JOIN "brand_source_document" d
    ON d."id" = c."sourceDocumentId" AND d."workspaceId" = c."workspaceId"
  WHERE d."id" IS NULL;

  SELECT count(*) INTO bad_jobs
  FROM "brand_ingestion_job" j
  LEFT JOIN "brand_source_document" d
    ON d."id" = j."sourceDocumentId" AND d."workspaceId" = j."workspaceId"
  WHERE d."id" IS NULL;

  SELECT count(*) INTO bad_messages
  FROM "brand_brain_message" m
  LEFT JOIN "brand_brain_conversation" k
    ON k."id" = m."conversationId" AND k."workspaceId" = m."workspaceId"
  WHERE k."id" IS NULL;

  -- F-83.
  SELECT count(*) INTO bad_cand_doc
  FROM "brand_knowledge_candidate" n
  LEFT JOIN "brand_source_document" d
    ON d."id" = n."sourceDocumentId" AND d."workspaceId" = n."workspaceId"
  WHERE d."id" IS NULL;

  SELECT count(*) INTO bad_cand_item
  FROM "brand_knowledge_candidate" n
  LEFT JOIN "brand_knowledge_item" i
    ON i."id" = n."targetItemId" AND i."workspaceId" = n."workspaceId"
  WHERE n."targetItemId" IS NOT NULL AND i."id" IS NULL;

  SELECT count(*) INTO bad_item_doc
  FROM "brand_knowledge_item" i
  LEFT JOIN "brand_source_document" d
    ON d."id" = i."sourceDocumentId" AND d."workspaceId" = i."workspaceId"
  WHERE i."sourceDocumentId" IS NOT NULL AND d."id" IS NULL;

  SELECT count(*) INTO bad_item_confl
  FROM "brand_knowledge_item" i
  LEFT JOIN "brand_knowledge_item" p
    ON p."id" = i."conflictsWithItemId" AND p."workspaceId" = i."workspaceId"
  WHERE i."conflictsWithItemId" IS NOT NULL AND p."id" IS NULL;

  SELECT count(*) INTO bad_versions
  FROM "brand_knowledge_version" v
  LEFT JOIN "brand_knowledge_item" i
    ON i."id" = v."knowledgeItemId" AND i."workspaceId" = v."workspaceId"
  WHERE i."id" IS NULL;

  IF bad_chunks + bad_jobs + bad_messages + bad_cand_doc + bad_cand_item
     + bad_item_doc + bad_item_confl + bad_versions > 0 THEN
    offending := format(
      'brand_source_chunk.sourceDocumentId=%s, '
      || 'brand_ingestion_job.sourceDocumentId=%s, '
      || 'brand_brain_message.conversationId=%s, '
      || 'brand_knowledge_candidate.sourceDocumentId=%s, '
      || 'brand_knowledge_candidate.targetItemId=%s, '
      || 'brand_knowledge_item.sourceDocumentId=%s, '
      || 'brand_knowledge_item.conflictsWithItemId=%s, '
      || 'brand_knowledge_version.knowledgeItemId=%s',
      bad_chunks, bad_jobs, bad_messages, bad_cand_doc, bad_cand_item,
      bad_item_doc, bad_item_confl, bad_versions);

    RAISE EXCEPTION USING
      ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'F-80/F-83 migration refused: rows reference a parent in another '
        || 'workspace (' || offending || ').',
      DETAIL  = 'The workspace-scoped foreign keys were NOT applied and no row was '
        || 'changed or removed. Such a row is evidence of a cross-tenant write and '
        || 'is an incident, not a data-cleanup task: investigate its origin before '
        || 'deciding what happens to it.',
      HINT    = 'List them with the same anti-join, e.g. SELECT c.id FROM '
        || '"brand_source_chunk" c LEFT JOIN "brand_source_document" d ON d."id" = '
        || 'c."sourceDocumentId" AND d."workspaceId" = c."workspaceId" WHERE d."id" IS NULL;';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. THE COMPOSITE TARGETS ON THE PARENT TABLES.
--
-- `id` is already the primary key, so `(workspaceId, id)` is unique by
-- construction — the index exists to give the foreign keys something to
-- reference, which PostgreSQL requires, not to constrain anything new. Created
-- as UNIQUE INDEXes rather than UNIQUE CONSTRAINTs to match what
-- `prisma migrate diff` emits for `@@unique([workspaceId, id])`, so a
-- migrations-only database and the schema stay byte-identical (the Asset
-- Library's `asset_folder_workspaceId_id_key` is the same shape).
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "brand_source_document_workspaceId_id_key"
  ON "brand_source_document"("workspaceId", "id");

CREATE UNIQUE INDEX "brand_brain_conversation_workspaceId_id_key"
  ON "brand_brain_conversation"("workspaceId", "id");

CREATE UNIQUE INDEX "brand_knowledge_item_workspaceId_id_key"
  ON "brand_knowledge_item"("workspaceId", "id");

-- ---------------------------------------------------------------------------
-- 4. REPLACE EACH PLAIN KEY WITH ITS WORKSPACE-SCOPED COMPOSITE.
--
-- Each `ADD CONSTRAINT` validates every existing row — for real, because §1
-- made them visible — so these statements are a second, independent check on
-- top of the pre-flight rather than a restatement of it.
--
-- ON UPDATE NO ACTION matches the Asset Library's intra-module keys: a
-- workspaceId is never rewritten, and a key that silently followed one would be
-- a cross-tenant move rather than an update.
--
-- ══ ON DELETE SET NULL NAMES ITS COLUMN, AND MUST ══════════════════════════
--
-- Three of these keys nulled a single nullable column when their parent was
-- deleted, and all three must go on doing exactly that. Writing the composite
-- form as a bare `ON DELETE SET NULL` would NOT preserve it: PostgreSQL nulls
-- EVERY referencing column of the key, which here means `workspaceId` as well.
-- `workspaceId` is NOT NULL, so the parent delete would not quietly corrupt the
-- tenant key — it would fail outright:
--
--   ERROR: null value in column "workspaceId" ... violates not-null constraint
--   CONTEXT: SQL statement "UPDATE ONLY ... SET "workspaceId" = NULL,
--            "targetItemId" = NULL WHERE ..."
--
-- Measured, not assumed. Deleting a knowledge item that any candidate targets
-- would have started erroring, which is a data-loss-shaped defect introduced by
-- a migration meant to close a leak.
--
-- `ON DELETE SET NULL ("<column>")` (PostgreSQL 15+; docs/ARCHITECTURE.md §
-- targets 16+ and CI runs 16) restricts the nulling to the one column that is
-- allowed to become NULL. The tenant key is never written by a referential
-- action. `pg_constraint.confdelsetcols` records it, and the isolation suite
-- asserts that column list rather than trusting the clause.
-- ---------------------------------------------------------------------------

-- F-80 ----------------------------------------------------------------------

ALTER TABLE "brand_source_chunk"
  DROP CONSTRAINT "brand_source_chunk_sourceDocumentId_fkey";

ALTER TABLE "brand_source_chunk"
  ADD CONSTRAINT "brand_source_chunk_document_fkey"
  FOREIGN KEY ("workspaceId", "sourceDocumentId")
  REFERENCES "brand_source_document"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "brand_ingestion_job"
  DROP CONSTRAINT "brand_ingestion_job_sourceDocumentId_fkey";

ALTER TABLE "brand_ingestion_job"
  ADD CONSTRAINT "brand_ingestion_job_document_fkey"
  FOREIGN KEY ("workspaceId", "sourceDocumentId")
  REFERENCES "brand_source_document"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "brand_brain_message"
  DROP CONSTRAINT "brand_brain_message_conversationId_fkey";

ALTER TABLE "brand_brain_message"
  ADD CONSTRAINT "brand_brain_message_conversation_fkey"
  FOREIGN KEY ("workspaceId", "conversationId")
  REFERENCES "brand_brain_conversation"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- F-83 ----------------------------------------------------------------------

ALTER TABLE "brand_knowledge_candidate"
  DROP CONSTRAINT "brand_knowledge_candidate_sourceDocumentId_fkey";

ALTER TABLE "brand_knowledge_candidate"
  ADD CONSTRAINT "brand_knowledge_candidate_document_fkey"
  FOREIGN KEY ("workspaceId", "sourceDocumentId")
  REFERENCES "brand_source_document"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "brand_knowledge_candidate"
  DROP CONSTRAINT "brand_knowledge_candidate_targetItemId_fkey";

ALTER TABLE "brand_knowledge_candidate"
  ADD CONSTRAINT "brand_knowledge_candidate_target_fkey"
  FOREIGN KEY ("workspaceId", "targetItemId")
  REFERENCES "brand_knowledge_item"("workspaceId", "id")
  ON DELETE SET NULL ("targetItemId") ON UPDATE NO ACTION;

ALTER TABLE "brand_knowledge_item"
  DROP CONSTRAINT "brand_knowledge_item_sourceDocumentId_fkey";

ALTER TABLE "brand_knowledge_item"
  ADD CONSTRAINT "brand_knowledge_item_source_fkey"
  FOREIGN KEY ("workspaceId", "sourceDocumentId")
  REFERENCES "brand_source_document"("workspaceId", "id")
  ON DELETE SET NULL ("sourceDocumentId") ON UPDATE NO ACTION;

ALTER TABLE "brand_knowledge_item"
  DROP CONSTRAINT "brand_knowledge_item_conflictsWithItemId_fkey";

ALTER TABLE "brand_knowledge_item"
  ADD CONSTRAINT "brand_knowledge_item_conflict_fkey"
  FOREIGN KEY ("workspaceId", "conflictsWithItemId")
  REFERENCES "brand_knowledge_item"("workspaceId", "id")
  ON DELETE SET NULL ("conflictsWithItemId") ON UPDATE NO ACTION;

ALTER TABLE "brand_knowledge_version"
  DROP CONSTRAINT "brand_knowledge_version_knowledgeItemId_fkey";

ALTER TABLE "brand_knowledge_version"
  ADD CONSTRAINT "brand_knowledge_version_item_fkey"
  FOREIGN KEY ("workspaceId", "knowledgeItemId")
  REFERENCES "brand_knowledge_item"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 5. RESTORE FORCE ROW LEVEL SECURITY.
-- ---------------------------------------------------------------------------

ALTER TABLE "brand_source_document"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_source_chunk"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_ingestion_job"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_conversation"   FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_message"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_item"       FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_version"    FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_knowledge_candidate"  FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 6. PROVE IT, RATHER THAN TRUSTING THE EIGHT LINES ABOVE.
--
-- The one way this migration could do real harm is by committing with FORCE
-- left off — a table whose owner is no longer subject to its own policies. That
-- would be one deleted line away, and nothing else in the file would notice. So
-- the catalogue is read back and the transaction refuses to commit unless all
-- eight tables are both ENABLED and FORCED.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  unprotected text;
BEGIN
  SELECT string_agg(relname, ', ' ORDER BY relname) INTO unprotected
  FROM pg_class
  WHERE relname IN ('brand_source_document', 'brand_source_chunk',
                    'brand_ingestion_job', 'brand_brain_conversation',
                    'brand_brain_message', 'brand_knowledge_item',
                    'brand_knowledge_version', 'brand_knowledge_candidate')
    AND NOT (relrowsecurity AND relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'F-80/F-83 migration aborted: row-level security is not ENABLED and FORCED on %',
      unprotected;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. AND PROVE THE TENANT KEY IS NEVER WRITTEN BY A REFERENTIAL ACTION.
--
-- The `ON DELETE SET NULL` column lists in §4 are the difference between
-- "nulls the reference" and "tries to null the workspace and fails". A future
-- edit that dropped a column list would look almost identical in review and
-- would not fail until a customer deleted a knowledge item. `confdelsetcols`
-- holds the answer, so it is checked here rather than left to a reviewer's eye:
-- every SET NULL key on these tables must name exactly one column, and it must
-- not be `workspaceId`.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(c.conname, ', ' ORDER BY c.conname) INTO offending
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.confdeltype = 'n'                       -- ON DELETE SET NULL
    AND c.conrelid IN ('brand_knowledge_candidate'::regclass,
                       'brand_knowledge_item'::regclass)
    AND (
      c.confdelsetcols IS NULL                    -- nulls EVERY column, incl. workspaceId
      OR cardinality(c.confdelsetcols) <> 1
      OR EXISTS (
        SELECT 1
        FROM unnest(c.confdelsetcols) AS col(attnum)
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = col.attnum
        WHERE a.attname = 'workspaceId'
      )
    );

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'F-83 migration aborted: ON DELETE SET NULL would null the tenant key on %',
      offending;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 8. NOTHING ELSE MOVED.
--
-- No policy is created, altered or dropped; no GRANT or REVOKE is issued; no
-- trigger is touched; no row is written or deleted. The least-privilege grants,
-- the append-only layers on `brand_knowledge_version` and the 404-shaped miss
-- all stand exactly as Phase 5A left them. This migration ADDS a boundary and
-- removes none.
-- ---------------------------------------------------------------------------

COMMIT;
