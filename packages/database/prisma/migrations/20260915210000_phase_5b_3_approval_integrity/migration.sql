-- ===========================================================================
-- Phase 5B-3 corrective pass — least privilege and approval-history integrity
--
-- Two defects in `20260915180000_phase_5b_3_approvals_activity_notifications`,
-- both of the same kind: the SQL granted more than the design called for, and
-- the comment beside it said otherwise.
--
--   1. THE GRANT DID NOT MATCH ITS OWN COMMENT. That migration's §9 explains
--      that `notification` is "the only one of the three the application may
--      DELETE" — and then granted DELETE on all three. An approval is the
--      record that somebody reviewed something; a workspace admin deleting one
--      through any application path erases the evidence that a review happened
--      at all, which is exactly the property the module exists to provide.
--
--   2. A TERMINAL APPROVAL COULD BE REWRITTEN. UPDATE was unrestricted, so raw
--      application-role SQL could move an `APPROVED` cycle back to `PENDING`,
--      change its verdict, reassign its subject, rewrite its requester, or
--      replace the `policySnapshot` it was judged under — silently, and after
--      the fact. The service never does any of that; the database did not stop
--      anything else from doing it.
--
-- WHAT IS DELIBERATELY STILL ALLOWED: the legitimate PENDING → terminal
-- transition, which is the whole workflow, and editing a PENDING row's
-- assignment or note before it is decided.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Least privilege. DELETE is revoked from the application role on both
--    approval tables.
--
-- `approval` is a record of a decision, and decisions are not the application's
-- to erase. `approval_policy` is reset by setting its columns back to NULL —
-- "no opinion", which is what an absent row means — so DELETE buys nothing
-- there either, and a policy row carries `updatedByUserId`: who last changed a
-- brand's approval rules is worth keeping.
--
-- The PLATFORM role keeps DELETE on both, because tenant offboarding and the
-- D-116 retention purge run there and must be able to remove a workspace's
-- rows entirely. `ON DELETE CASCADE` from `workspace` is unaffected: a cascade
-- runs with the privileges of the deleting statement, which is the platform's.
-- ---------------------------------------------------------------------------

REVOKE DELETE ON "approval" FROM brandspace_app;
REVOKE DELETE ON "approval_policy" FROM brandspace_app;

-- ---------------------------------------------------------------------------
-- 2. A terminal approval is immutable, and a pending one may only move forward.
--
-- Enforced by a trigger rather than by a CHECK, because the rule is about the
-- TRANSITION — old row versus new row — and a CHECK sees only the new one.
--
-- The trigger is deliberately narrow. It does not care who is writing or why;
-- it states the two facts that must hold however the write arrives:
--
--   * a cycle that has been decided or withdrawn never changes again, and
--   * the identity of a cycle — its subject, its requester, the policy it was
--     judged under and the round it is — never changes at all.
--
-- `decidedByUserId`, `decidedAt`, `decisionNote` and `status` may still be
-- written while the row is PENDING, which is exactly what `decide()` does.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION approval_is_write_once() RETURNS trigger AS $$
BEGIN
  -- The immutable spine of a cycle. Changing any of it would make the history
  -- describe a review that did not happen.
  IF NEW."workspaceId"    IS DISTINCT FROM OLD."workspaceId"
     OR NEW."brandId"         IS DISTINCT FROM OLD."brandId"
     OR NEW."subjectType"     IS DISTINCT FROM OLD."subjectType"
     OR NEW."contentItemId"   IS DISTINCT FROM OLD."contentItemId"
     OR NEW."requestedByUserId" IS DISTINCT FROM OLD."requestedByUserId"
     OR NEW."cycle"           IS DISTINCT FROM OLD."cycle"
     OR NEW."createdAt"       IS DISTINCT FROM OLD."createdAt"
     OR NEW."policySnapshot"  IS DISTINCT FROM OLD."policySnapshot" THEN
    RAISE EXCEPTION
      'approval % identity is immutable (subject, requester, cycle and policy snapshot)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- A decided or withdrawn cycle is finished. Resubmission opens a NEW row,
  -- which is what keeps "who approved this, and when" a stable answer.
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'approval % is already %, and cannot be reopened or rewritten',
      OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approval_write_once
  BEFORE UPDATE ON "approval"
  FOR EACH ROW EXECUTE FUNCTION approval_is_write_once();

COMMIT;
