-- ---------------------------------------------------------------------------
-- F-80 — THE THREE PHASE 5A FOREIGN KEYS THAT WERE CROSS-TENANT EXISTENCE
-- ORACLES.
--
-- Phase 5A shipped three foreign keys that reference a parent BY ID ALONE:
--
--   brand_source_chunk."sourceDocumentId"  -> brand_source_document(id)
--   brand_ingestion_job."sourceDocumentId" -> brand_source_document(id)
--   brand_brain_message."conversationId"   -> brand_brain_conversation(id)
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
-- one. All three were probed directly against the test database during Phase
-- 5B-1 and all three were confirmed.
--
-- THE FIX IS THE ONE THE ASSET LIBRARY ALREADY USES (D-99). Each key becomes
-- composite on `(workspaceId, <parent id>)` against a `(workspaceId, id)`
-- unique on the parent. The oracle collapses from "does this id exist
-- anywhere" to "is this a row in MY OWN workspace", which discloses nothing a
-- caller did not already have. The referenced row becomes INVISIBLE rather
-- than merely unusable.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO. It drops no column, rewrites
-- no row, and deletes nothing. Every valid row survives it untouched. The only
-- destructive statement available here would be to remove rows that violate
-- the new constraint, and that is precisely the thing a migration must never
-- decide on its own: the pre-flight below REFUSES rather than repairs, and
-- names the table and the count so an operator can look before anything is
-- lost.
--
-- Scope: F-80 as recorded, and nothing else. `brand_knowledge_candidate` still
-- holds two plain keys of the same shape; they are recorded as F-83 rather
-- than folded in here, for the same reason F-80 was not folded into Phase
-- 5B-1 — a fix buried inside an unrelated change is a fix nobody reviewed.
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
-- These five tables are `FORCE ROW LEVEL SECURITY` with policies for
-- `brandspace_app` and `brandspace_platform` only. FORCE means the TABLE OWNER
-- is subject to RLS too, and the owner is `brandspace_migrator` — the role
-- Prisma runs migrations as. No policy names it, so the default deny applies
-- and the migrator sees ZERO ROWS in all five tables.
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
-- application and platform roles are unaffected throughout.
-- ---------------------------------------------------------------------------

ALTER TABLE "brand_source_document"    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_source_chunk"       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_ingestion_job"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_conversation" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_message"      NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. PRE-FLIGHT. FAIL, DO NOT REPAIR.
--
-- A RAISE here aborts the transaction opened above and leaves the database
-- exactly as it was. The message carries the table and a COUNT — never an id, a
-- workspace or any row content: a migration log is not a place customer data
-- belongs, and the operator who needs the rows can run the same anti-join
-- themselves.
--
-- IT ALSO HAS TO COME BEFORE THE CONSTRAINTS FOR A SECOND REASON. PostgreSQL's
-- own foreign-key violation on `ADD CONSTRAINT` is perfectly capable of
-- catching these rows now that §1 has made them visible — but its DETAIL line
-- prints the offending key, which here is a workspace id and a document id.
-- Refusing first means the failure an operator actually sees carries counts and
-- no identifiers.
--
-- The anti-join catches both failure modes at once. A row whose parent is in
-- ANOTHER workspace fails to match, and so does a row whose parent does not
-- exist at all — the second is impossible under the plain key being replaced,
-- and is checked anyway because "impossible" is an assumption and this is the
-- one moment it can be verified for free.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad_chunks    bigint;
  bad_jobs      bigint;
  bad_messages  bigint;
BEGIN
  SELECT count(*) INTO bad_chunks
  FROM "brand_source_chunk" c
  LEFT JOIN "brand_source_document" d
    ON d."id" = c."sourceDocumentId"
   AND d."workspaceId" = c."workspaceId"
  WHERE d."id" IS NULL;

  SELECT count(*) INTO bad_jobs
  FROM "brand_ingestion_job" j
  LEFT JOIN "brand_source_document" d
    ON d."id" = j."sourceDocumentId"
   AND d."workspaceId" = j."workspaceId"
  WHERE d."id" IS NULL;

  SELECT count(*) INTO bad_messages
  FROM "brand_brain_message" m
  LEFT JOIN "brand_brain_conversation" k
    ON k."id" = m."conversationId"
   AND k."workspaceId" = m."workspaceId"
  WHERE k."id" IS NULL;

  IF bad_chunks > 0 OR bad_jobs > 0 OR bad_messages > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'integrity_constraint_violation',
      MESSAGE = format(
        'F-80 migration refused: rows reference a parent in another workspace '
        || '(brand_source_chunk=%s, brand_ingestion_job=%s, brand_brain_message=%s).',
        bad_chunks, bad_jobs, bad_messages),
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
-- construction — the index exists to give the foreign key something to
-- reference, which PostgreSQL requires, not to constrain anything new. Created
-- as a UNIQUE INDEX rather than a UNIQUE CONSTRAINT to match what
-- `prisma migrate diff` emits for `@@unique([workspaceId, id])`, so a
-- migrations-only database and the schema stay byte-identical (the Asset
-- Library's `asset_folder_workspaceId_id_key` is the same shape).
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "brand_source_document_workspaceId_id_key"
  ON "brand_source_document"("workspaceId", "id");

CREATE UNIQUE INDEX "brand_brain_conversation_workspaceId_id_key"
  ON "brand_brain_conversation"("workspaceId", "id");

-- ---------------------------------------------------------------------------
-- 4. REPLACE EACH PLAIN KEY WITH ITS WORKSPACE-SCOPED COMPOSITE.
--
-- Each `ADD CONSTRAINT` validates every existing row — for real, because §1
-- made them visible — so these statements are a second, independent check on
-- top of the pre-flight rather than a restatement of it.
--
-- ON DELETE CASCADE is preserved exactly: deleting a document still removes
-- its chunks and its ingestion jobs, and deleting a conversation still removes
-- its messages. ON UPDATE NO ACTION matches the Asset Library's intra-library
-- keys — a workspaceId is never rewritten, and a key that silently followed
-- one would be a cross-tenant move rather than an update.
--
-- Each constraint is dropped and recreated in the same transaction, so there
-- is no window in which the child table is unprotected.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 5. RESTORE FORCE ROW LEVEL SECURITY.
-- ---------------------------------------------------------------------------

ALTER TABLE "brand_source_document"    FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_source_chunk"       FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_ingestion_job"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_conversation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_message"      FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 6. PROVE IT, RATHER THAN TRUSTING THE FIVE LINES ABOVE.
--
-- The one way this migration could do real harm is by committing with FORCE
-- left off — a table whose owner is no longer subject to its own policies. That
-- would be one deleted line away, and nothing else in the file would notice. So
-- the catalogue is read back and the transaction refuses to commit unless all
-- five tables are both ENABLED and FORCED.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  unprotected text;
BEGIN
  SELECT string_agg(relname, ', ' ORDER BY relname) INTO unprotected
  FROM pg_class
  WHERE relname IN ('brand_source_document', 'brand_source_chunk',
                    'brand_ingestion_job', 'brand_brain_conversation',
                    'brand_brain_message')
    AND NOT (relrowsecurity AND relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'F-80 migration aborted: row-level security is not ENABLED and FORCED on %',
      unprotected;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. NOTHING ELSE MOVED.
--
-- No policy is created, altered or dropped; no GRANT or REVOKE is issued; no
-- trigger is touched; no row is written or deleted. The least-privilege grants,
-- the append-only layers on `brand_knowledge_version` and the 404-shaped miss
-- all stand exactly as Phase 5A left them. This migration ADDS a boundary and
-- removes none.
-- ---------------------------------------------------------------------------

COMMIT;
