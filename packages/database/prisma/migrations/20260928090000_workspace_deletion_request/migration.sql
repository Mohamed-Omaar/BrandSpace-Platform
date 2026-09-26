-- Prototype v94 Phase 2B-1, A8 (D-328): the owner's workspace deletion request.
--
-- SCHEMA ONLY, ADDITIVE. Three NULLABLE columns on "workspace", one index and
-- one foreign key. Nothing is backfilled and no row is inserted, updated or
-- deleted, so a freshly migrated EMPTY database stays empty.
--
-- SAFE WHILE THE PREVIOUS RELEASE IS LIVE. The previous release neither reads
-- nor writes these columns, and every existing row gets NULL — "no deletion
-- requested" — which is exactly what that release assumes today. Only the new
-- release sets them, from the owner's confirmed request.
--
-- ROLLBACK is by a forward migration (drop the columns), never by replaying or
-- editing this file.

ALTER TABLE "workspace" ADD COLUMN     "deletionRequestedAt" TIMESTAMPTZ(6),
ADD COLUMN     "deletionRequestedByUserId" UUID,
ADD COLUMN     "deletionScheduledFor" TIMESTAMPTZ(6);

-- The job that finishes a deletion asks for the due ones by this column.
CREATE INDEX "workspace_deletionScheduledFor_idx" ON "workspace"("deletionScheduledFor");

-- Who asked. SET NULL, so erasing that person later never blocks or rewrites
-- the workspace's own lifecycle.
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_deletionRequestedByUserId_fkey" FOREIGN KEY ("deletionRequestedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A request is a pair: when it was asked for and when it takes effect, both or
-- neither. A half-written request could not be cancelled or finished honestly.
ALTER TABLE "workspace"
  ADD CONSTRAINT "workspace_deletion_request_coherent"
  CHECK (("deletionRequestedAt" IS NULL) = ("deletionScheduledFor" IS NULL));
