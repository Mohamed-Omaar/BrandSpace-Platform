-- ---------------------------------------------------------------------------
-- PHASE 7 REMEDIATION, ROUND 3
--
-- Two runtime lifecycles that were each missing a piece of durable state, and
-- were papering over the gap with something that looked equivalent and was not.
--
--   1. A THRESHOLD CROSSING IS A TRANSITION, and a transition cannot be read off
--      one sweep. Comparing the current rolling window against the previous
--      adjacent one stays true for as long as the metric stays past the line, so
--      every pass saw a "crossing"; dedupe on the latest observation's id hid it
--      until the next reading arrived and then fired the same alert again. The
--      rule now REMEMBERS which side it is on.
--
--   2. AN EXTERNAL PROPOSAL HAD NO END. Its confirmation window could close with
--      the run still `AWAITING_CONFIRMATION`, so the screen kept offering a
--      Confirm control for something nothing could confirm. `EXPIRED` is that
--      ending, and it is distinct from `CANCELLED` because cancelled is a
--      decision somebody made and expired is one nobody made.
--
-- D-113: ONE EXPLICIT TRANSACTION.
--
-- `ALTER TYPE … ADD VALUE` inside a transaction block is permitted from
-- PostgreSQL 12 onward provided the new label is not USED before the commit —
-- and nothing below uses it. The platform targets 16 (docs/ARCHITECTURE.md) and
-- CI runs 16.
-- ---------------------------------------------------------------------------
BEGIN;

ALTER TYPE "AutomationRunStatus" ADD VALUE 'EXPIRED';

-- ---------------------------------------------------------------------------
-- THE THRESHOLD RULE'S MEMORY.
--
-- `thresholdBreached` is DELIBERATELY NULLABLE, and null is not "false": it
-- means the rule has never been evaluated. The first evaluation records the side
-- and fires nothing, because a rule somebody created while the metric was
-- already past the line has not seen anything cross SINCE THEY ASKED. Starting
-- at false would alert immediately on a number that had been sitting there for
-- months, which is the fastest way to teach a customer to ignore the feature.
--
-- `thresholdCycle` is the identity of the current ARMING. It increments when the
-- metric returns to the non-triggered side, and the outbox dedupe key is built
-- from it — so any number of sweeps inside one arming write one event, and the
-- next genuine crossing writes exactly one more.
-- ---------------------------------------------------------------------------
ALTER TABLE "automation_rule"
  ADD COLUMN "thresholdBreached"    BOOLEAN,
  ADD COLUMN "thresholdCycle"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "thresholdEvaluatedAt" TIMESTAMPTZ(6);

-- A cycle counts arming events; it never runs backwards.
ALTER TABLE "automation_rule" ADD CONSTRAINT "automation_rule_threshold_cycle_non_negative"
  CHECK ("thresholdCycle" >= 0);

COMMIT;
