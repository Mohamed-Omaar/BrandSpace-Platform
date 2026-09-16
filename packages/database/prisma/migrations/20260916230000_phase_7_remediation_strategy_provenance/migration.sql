-- ---------------------------------------------------------------------------
-- Phase 7 remediation — an insight records the insight it was generated FROM.
--
-- ONE NULLABLE COLUMN, ONE COMPOSITE FOREIGN KEY, ONE INDEX. Nothing is
-- dropped, nothing is rewritten, and no existing row changes: safe on a fresh
-- database and on an upgrade from a populated one alike.
--
-- WHY IT EXISTS. `plan.monthly` claims to be grounded in an ACCEPTED strategy,
-- and until now that claim lived entirely in a prompt: the generated plan
-- stored no link, so a reader could not tell which strategy it followed from,
-- and nothing could detect a plan still being shown after its strategy was
-- superseded. The relation is the smallest thing that makes the claim checkable.
--
-- THE KEY IS COMPOSITE (D-112), and self-referential. A plain
-- `sourceInsightId -> insight(id)` would resolve ANOTHER workspace's insight:
-- PostgreSQL evaluates referential integrity as the table owner with RLS
-- bypassed, so "inserted" versus "violates foreign key" would answer "does that
-- insight exist?" across the tenant boundary. Including `workspaceId` in the
-- key makes a foreign id indistinguishable from a fabricated one.
--
-- THE `SET NULL` NAMES ITS COLUMN (D-114). A bare SET NULL on a composite key
-- nulls EVERY referencing column, `workspaceId` included — and `workspaceId` is
-- NOT NULL, so the delete would fail outright.
--
-- ONE EXPLICIT TRANSACTION (D-113). Prisma does not wrap a migration file in
-- one, and a half-applied column with no key is a worse state than no column.
-- It does NOT lift FORCE RLS: nothing here reads or rewrites a tenant row.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE "insight" ADD COLUMN "sourceInsightId" UUID;

ALTER TABLE "insight"
  ADD CONSTRAINT "insight_source_fkey"
  FOREIGN KEY ("workspaceId", "sourceInsightId")
  REFERENCES "insight"("workspaceId", "id")
  ON DELETE SET NULL ("sourceInsightId")
  ON UPDATE NO ACTION;

CREATE INDEX "insight_workspaceId_sourceInsightId_idx"
  ON "insight"("workspaceId", "sourceInsightId");

COMMIT;
