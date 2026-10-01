-- PHASE 2B-3 PR 6 (M5a) — the two run statuses of an AI automation action.
--
-- SCHEMA ONLY, ADDITIVE. Two values on "AutomationRunStatus". No row is
-- inserted, updated or rewritten: no customer data, no sample data, no backfill.
-- An empty database receives the two values and nothing else.
--
--   AWAITING_EXECUTION — the engine's gates passed and the run waits for the
--     API's AI executor (the worker has no AI gateway, F-07 / F-68).
--   EXECUTING — the executor holds the run's lease and is drafting the ideas.
--
-- ITS OWN MIGRATION ON PURPOSE (the D-379 pattern): M5b
-- (`20261015091000_automation_ai_execution_lease`) names both values in its
-- CHECKs, and a value added by `ALTER TYPE … ADD VALUE` cannot be used in the
-- transaction that added it.
--
-- LOCKING. `ADD VALUE` takes a brief lock on the type; no table is rewritten.
--
-- FORWARD-ONLY (OPERATIONS §6.13). An enum value cannot be dropped in place. A
-- run the new release writes in either status cannot be decoded by a previous
-- release's Prisma client, so the previous release is never redeployed once a
-- run is in either status.

ALTER TYPE "AutomationRunStatus" ADD VALUE IF NOT EXISTS 'AWAITING_EXECUTION';
ALTER TYPE "AutomationRunStatus" ADD VALUE IF NOT EXISTS 'EXECUTING';
