-- Rename the Phase 4 foreign keys to the convention the rest of the schema uses.
--
-- Every other table names its constraints `<table>_<column>_fkey`, which is what
-- Prisma generates. 20260909100000 named its three `<table>_<purpose>_fkey`
-- instead. Nothing behaves differently, but `prisma migrate diff` reports the
-- difference as drift, and a future `prisma migrate dev` would emit a migration
-- to "fix" it — so the fix is made deliberately here rather than left as a trap
-- in someone else's diff.
--
-- The same migration's `correctsLedgerId` foreign key existed only in SQL: the
-- datamodel declared the column with no relation. The relation is now declared
-- in schema.prisma too, so the constraint is no longer something a datamodel
-- change could silently drop.

ALTER TABLE "ai_request"
  RENAME CONSTRAINT "ai_request_workspace_fkey" TO "ai_request_workspaceId_fkey";

ALTER TABLE "ai_usage_ledger"
  RENAME CONSTRAINT "ai_usage_ledger_workspace_fkey" TO "ai_usage_ledger_workspaceId_fkey";

ALTER TABLE "ai_usage_ledger"
  RENAME CONSTRAINT "ai_usage_ledger_request_fkey" TO "ai_usage_ledger_aiRequestId_fkey";

ALTER TABLE "ai_usage_ledger"
  RENAME CONSTRAINT "ai_usage_ledger_corrects_fkey" TO "ai_usage_ledger_correctsLedgerId_fkey";

-- And the same migration's foreign keys omitted ON UPDATE, so PostgreSQL used
-- NO ACTION where every other table in the schema uses CASCADE — the Prisma
-- default for a required relation, and the remaining source of drift. A primary
-- key is never updated in this system, so nothing behaves differently today;
-- the point is that the declared model and the database agree, so a future
-- `prisma migrate dev` has nothing to "correct".
--
-- PostgreSQL has no ALTER CONSTRAINT for this, so each one is dropped and
-- recreated. The tables are Phase 4's own and hold no production data.

ALTER TABLE "ai_request" DROP CONSTRAINT "ai_request_workspaceId_fkey";
ALTER TABLE "ai_request"
  ADD CONSTRAINT "ai_request_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_usage_ledger" DROP CONSTRAINT "ai_usage_ledger_workspaceId_fkey";
ALTER TABLE "ai_usage_ledger"
  ADD CONSTRAINT "ai_usage_ledger_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_usage_ledger" DROP CONSTRAINT "ai_usage_ledger_aiRequestId_fkey";
ALTER TABLE "ai_usage_ledger"
  ADD CONSTRAINT "ai_usage_ledger_aiRequestId_fkey"
  FOREIGN KEY ("aiRequestId") REFERENCES "ai_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `attemptedModelKeys` KEEPS its '{}' database default. The datamodel now
-- declares `@default([])` to match, rather than the default being dropped to
-- match the datamodel: an insert that omits a scalar list does NOT send an
-- empty array, so dropping it turned every such insert into a NOT NULL
-- violation. Caught by the budget-concurrency test, which builds an AiRequest
-- row without naming the column.
