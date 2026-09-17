-- ---------------------------------------------------------------------------
-- PHASE 7 REMEDIATION, ROUND 4 — THE RULE-DERIVED PRODUCERS' FAIR-WORK CURSOR.
--
-- THE DEFECT. `#produceTimedEvents` and `#produceThresholdEvents` asked "which
-- enabled rules carry this trigger?" and took the first `batch` rows — with no
-- ordering, no cursor and no durable next-evaluation marker. The default batch
-- is 200.
--
-- An OUTBOX ROW retires: once `deliveredAt` is set the same query never returns
-- it again, so `LIMIT` there is honest pagination through shrinking work. AN
-- EVALUATED RULE DOES NOT RETIRE. It is enabled before the sweep and enabled
-- after it, so the identical query on the next minute is free to return the
-- identical subset — and with more than `batch` rules the ones outside that
-- subset may never be evaluated at all.
--
-- For a threshold rule that is a stalled memory. For `SCHEDULED_TIME` it is
-- worse than a delay: the trigger's whole meaning is "in the customer's own
-- hour", and an hour that passes unevaluated is an occurrence MISSED BY DESIGN,
-- silently, for ever.
--
-- THE FIX IS A DURABLE PER-RULE CURSOR, which is the same shape
-- `analytics_ingestion_cursor.nextAttemptAt` already uses for the ingestion
-- sweep. The producer takes the OLDEST-DUE rules and parks every rule it
-- visits, so the enumeration is a queue rather than an arbitrary window:
--
--   * every enabled rule reaches the front within ceil(rules / batch) passes;
--   * a rule cannot hold the front, because visiting it is what moves it back;
--   * a timed rule parks until its NEXT OCCURRENCE, so rules that are nowhere
--     near due do not compete for the batch with the ones that are;
--   * the work per pass stays bounded by exactly the same `batch`.
--
-- WHY `nextEvaluationAt` IS NOT NULL. `ORDER BY … ASC` puts NULLs LAST in
-- PostgreSQL. A nullable cursor would therefore have sent every rule that had
-- never been evaluated — which is to say every newly created rule — to the back
-- of the very queue that exists to reach it, re-creating the starvation in a
-- new place. The default is `now()`, so a new rule is due immediately, and the
-- backfill below puts existing rules in creation order.
--
-- D-113: ONE EXPLICIT TRANSACTION.
-- ---------------------------------------------------------------------------
BEGIN;

ALTER TABLE "automation_rule"
  ADD COLUMN "nextEvaluationAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastEvaluatedAt"  TIMESTAMPTZ(6);

-- ---------------------------------------------------------------------------
-- THE BACKFILL, AND WHY FORCE HAS TO COME OFF FOR IT.
--
-- EXISTING RULES ENTER THE QUEUE IN CREATION ORDER rather than all at the same
-- instant. `now()` for every row leaves the id tie-break as the only ordering
-- there is, and a tie-break is not a fairness guarantee.
--
-- `automation_rule` is ENABLE + FORCE, and the MIGRATOR role is NOBYPASSRLS
-- like every other role here (docs/SECURITY.md §2.2) — it owns the table and is
-- still subject to its policies, and there is no policy that admits it. So a
-- plain `UPDATE` here does not fail: it reports `UPDATE 0` and commits, and the
-- migration would have shipped a backfill that silently did nothing. A no-op
-- that looks like a success is worse than an error.
--
-- FORCE IS LIFTED FOR THE DURATION OF THIS TRANSACTION AND RESTORED BELOW, the
-- same remedy and the same shape as the F-80/F-83 migration. No other session
-- can observe the lifted state: `ALTER TABLE` takes an ACCESS EXCLUSIVE lock
-- and holds it to COMMIT, which excludes every other reader and writer for
-- exactly that interval, and a ROLLBACK restores the catalogue with everything
-- else. `ENABLE ROW LEVEL SECURITY` is not touched, no policy is touched, and
-- the application and platform roles are unaffected throughout.
-- ---------------------------------------------------------------------------
ALTER TABLE "automation_rule" NO FORCE ROW LEVEL SECURITY;

UPDATE "automation_rule" SET "nextEvaluationAt" = "createdAt";

ALTER TABLE "automation_rule" FORCE ROW LEVEL SECURITY;

-- PROVE IT, rather than trusting the line above. Committing with FORCE left off
-- would be one deleted line away and nothing else in the file would notice.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'automation_rule' AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION
      'fair-work-cursor migration aborted: row-level security is not ENABLED and FORCED on automation_rule';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- THE PRODUCERS' OWN INDEX, and the only cross-tenant one on this table.
--
-- The sweep asks a PLATFORM-WIDE question — which rules of this trigger are
-- enabled and due — so this index cannot lead with `workspaceId` the way every
-- tenant-facing index on `automation_rule` does. That is not a widening of any
-- boundary: enumeration has always been the cross-tenant half (F-07), and every
-- row the sweep then reads or writes inside a workspace goes through
-- `withWorkspace` under that tenant's own RLS.
-- ---------------------------------------------------------------------------
CREATE INDEX "automation_rule_triggerType_enabled_nextEvaluationAt_idx"
  ON "automation_rule" ("triggerType", "enabled", "nextEvaluationAt");

COMMIT;
