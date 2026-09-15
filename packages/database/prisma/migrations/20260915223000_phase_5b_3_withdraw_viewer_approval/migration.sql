-- Phase 5B-3 — withdraw the D-121 Viewer approval grant (D-62 is authoritative).
--
-- D-121 made `approval_policy."clientApprovalEnabled"` a per-brand switch that
-- admitted the read-only Viewer as a reviewer. D-62 requires Viewer to remain
-- strictly read-only for the MVP: the product has no Client Portal, no client
-- hand-off, and no external reviewer surface, so there is nothing for that
-- switch to mean yet.
--
-- WHY THE COLUMN STAYS. The idea is deferred, not rejected — a future
-- External Review / Guest Approval capability is expected to want a per-brand
-- switch of this shape, implemented as its own narrow actor rather than by
-- repurposing `client_viewer`. Dropping the column would throw away structure
-- a cycle's `policySnapshot` already records.
--
-- WHY A CONSTRAINT RATHER THAN A CONVENTION. The application no longer reads
-- this column for any decision and no longer offers a way to set it, but a
-- column a customer could still turn on is exactly the decorative,
-- half-enforced state this milestone spent a corrective pass removing. The
-- same treatment `notification_channel_is_deliverable` already gives
-- `NotificationChannel`: the database says what is not yet real.
--
-- WHAT IS NOT TOUCHED. `approval."policySnapshot"` is left exactly as written,
-- including any historical `clientApprovalEnabled: true`. An approval is the
-- record of a review that actually happened under the rules that were actually
-- in force; rewriting it would be falsifying history, and
-- `approval_is_write_once` forbids it in any case. Nothing reads a snapshot
-- for authority — `mayApproveForBrand` sees only the caller's permissions — so
-- a historical `true` grants nothing. `tests/isolation/approvals-concurrency`
-- asserts exactly that.

-- ---------------------------------------------------------------------------
-- 1. RLS. `approval_policy` is ENABLE + FORCE, so the migrator — which OWNS
--    the table — is still subject to its policies, and a normalizing UPDATE
--    would silently match ZERO rows while the constraint below then failed on
--    the rows it could not see. That is not hypothetical: it is what happened
--    on the first run of this migration.
--
--    PostgreSQL's own prescribed remedy, as `20260914200000` already
--    documents: `SET LOCAL row_security = off` fails for a FORCEd table with
--    `HINT: To disable the policy for the table's owner, use ALTER TABLE NO
--    FORCE ROW LEVEL SECURITY.`
--
--    ENABLE is NOT touched, the policies are NOT touched, and no GRANT is
--    issued. The application and platform roles are unaffected throughout.
--    §4 asserts FORCE is back on rather than assuming it.
-- ---------------------------------------------------------------------------

ALTER TABLE "approval_policy" NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Normalize. Any brand that had switched the grant on loses it — that IS
--    the product decision, applied to data rather than only to code.
-- ---------------------------------------------------------------------------

UPDATE "approval_policy"
   SET "clientApprovalEnabled" = FALSE
 WHERE "clientApprovalEnabled" IS TRUE;

-- ---------------------------------------------------------------------------
-- 3. Pin it. NULL stays legal — it is the sparse table's "no opinion" — so the
--    constraint forbids only TRUE.
-- ---------------------------------------------------------------------------

ALTER TABLE "approval_policy"
  ADD CONSTRAINT "approval_policy_client_approval_withdrawn"
  CHECK ("clientApprovalEnabled" IS NOT TRUE);

COMMENT ON CONSTRAINT "approval_policy_client_approval_withdrawn" ON "approval_policy" IS
  'D-62 supersedes D-121: Viewer is strictly read-only in the MVP. Reserved for a future External Review / Guest Approval actor.';

-- ---------------------------------------------------------------------------
-- 4. Restore FORCE, and ASSERT it rather than trust it. A migration that left
--    this table readable by its owner outside RLS would be a tenant-isolation
--    regression introduced by a product change.
-- ---------------------------------------------------------------------------

ALTER TABLE "approval_policy" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = '"approval_policy"'::regclass
       AND relrowsecurity IS TRUE
       AND relforcerowsecurity IS TRUE
  ) THEN
    RAISE EXCEPTION
      'approval_policy must have RLS ENABLED and FORCED after this migration';
  END IF;
END $$;
