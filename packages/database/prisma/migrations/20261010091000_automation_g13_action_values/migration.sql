-- PHASE 2B-3 PR 1 (M1b) — the G13 automation actions, as enum values only.
--
-- SCHEMA ONLY, ADDITIVE. Eight values on "AutomationActionType". No row is
-- inserted, updated or rewritten: no customer data, no sample data, no backfill.
-- An empty database receives the eight values and nothing else.
--
-- NONE IS AUTHORABLE OR EXECUTABLE YET. The registry declares each action's
-- requirements (permissions all-of / any-of, entitlements, credits, asks-first)
-- and marks it `authorable: false, executable: false` until the PR that
-- implements it; the engine refuses to run one and `createRule` refuses to
-- store one.
--
-- ITS OWN MIGRATION ON PURPOSE (the D-379 pattern): M1c
-- (`20261010092000_automation_g13_checks_and_state`) names `RETRY_PUBLISH` and
-- `PAUSE_CAMPAIGN` in the external-confirmation CHECK, and a value added by
-- `ALTER TYPE … ADD VALUE` cannot be used in the transaction that added it.
--
-- NOT A SIMPLE ROLLBACK. An enum value cannot be dropped in place; a row the new
-- release writes with one of these values cannot be decoded by a previous
-- release's Prisma client (docs/OPERATIONS.md §6.3).

ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'SCHEDULE_NEXT_FREE_SLOT';
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'NOTIFY_PERSON';
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'ADD_TO_CAMPAIGN';
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'REMIND_REVIEWER';
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'DRAFT_IDEAS';
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'MAKE_DRAFT_COPY';
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'RETRY_PUBLISH';
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'PAUSE_CAMPAIGN';
