-- PHASE 2B-3 PR 1 (M1a) — the G13 automation triggers, as enum values only.
--
-- SCHEMA ONLY, ADDITIVE. Eight values on "AutomationTrigger". No row is
-- inserted, updated or rewritten: no customer data, no sample data, no backfill.
-- An empty database receives the eight values and nothing else.
--
-- NOTHING PRODUCES OR AUTHORS THEM YET (D-173). The registry declares each of
-- them `authorable: false` until the PR that ships its producer; this migration
-- only makes the values representable, so the database and the Prisma client
-- agree about the enum from the first release that knows them.
--
-- ITS OWN MIGRATION ON PURPOSE (the D-379 pattern). PostgreSQL does not allow a
-- value added by `ALTER TYPE … ADD VALUE` to be USED in the transaction that
-- added it, and M1c (`20261010092000_automation_g13_checks_and_state`) names
-- these values in its CHECK constraints. Prisma applies each migration in its
-- own transaction, so M1c sees them committed.
--
-- `CONNECTION_EXPIRING` IS DELIBERATELY ABSENT: deferred until real provider
-- adapters and authoritative grant-expiry semantics exist (owner decision OD-5).
--
-- NOT A SIMPLE ROLLBACK. An enum value cannot be dropped in place. The previous
-- release never writes these values; a row the new release writes with one of
-- them cannot be decoded by a previous release's Prisma client (the same
-- forward-only caveat as M4a, docs/OPERATIONS.md §6.3).

ALTER TYPE "AutomationTrigger" ADD VALUE IF NOT EXISTS 'POST_FAILED';
ALTER TYPE "AutomationTrigger" ADD VALUE IF NOT EXISTS 'REVIEW_WAITING_24H';
ALTER TYPE "AutomationTrigger" ADD VALUE IF NOT EXISTS 'CAMPAIGN_STARTED';
ALTER TYPE "AutomationTrigger" ADD VALUE IF NOT EXISTS 'CAMPAIGN_ENDED';
ALTER TYPE "AutomationTrigger" ADD VALUE IF NOT EXISTS 'WEEKLY_ENGAGEMENT_DROPPED';
ALTER TYPE "AutomationTrigger" ADD VALUE IF NOT EXISTS 'SCHEDULE_GAP';
ALTER TYPE "AutomationTrigger" ADD VALUE IF NOT EXISTS 'POST_TOP_10_PERCENT';
ALTER TYPE "AutomationTrigger" ADD VALUE IF NOT EXISTS 'FACT_EXPIRING';
