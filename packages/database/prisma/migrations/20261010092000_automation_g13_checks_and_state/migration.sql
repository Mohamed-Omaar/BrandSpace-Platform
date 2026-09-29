-- PHASE 2B-3 PR 1 (M1c) — the automation CHECKs learn the G13 values, and a rule
-- gains its no-backfill boundary and its due-date cursor.
--
-- SCHEMA ONLY. Three CHECK constraints are REPLACED by wider ones and two
-- NULLABLE columns are added. No row is inserted, updated or rewritten: no
-- customer data, no sample data, no backfill. An empty database receives the
-- constraints and the columns and nothing else.
--
-- EVERY EXISTING ROW STILL SATISFIES THE NEW CONSTRAINTS. The branches for the
-- seven existing trigger values and the four existing action values are exactly
-- what they were; the new branches only admit rows naming the new values, which
-- nothing writes yet. So each ADD CONSTRAINT validates against the rows already
-- there without a rewrite.
--
-- PRISMA AND POSTGRESQL AGREE (report §11). M1a and M1b made the values
-- representable; without these CHECKs `automation_event_ref_matches_trigger`
-- would still end in `ELSE FALSE` for them and PostgreSQL would reject a value
-- the client accepts.
--
-- RLS AND GRANTS: unchanged. Both tables are already under their tenant policy
-- (ENABLE + FORCE) and the runtime roles' table-level grants cover new columns.
--
-- NOT A SIMPLE ROLLBACK — see M1a/M1b and docs/OPERATIONS.md §6.3. The previous
-- release never writes the new values and never reads the new columns, so the
-- wider CHECKs and the NULL columns are harmless to it.

-- ---------------------------------------------------------------------------
-- 1. WHAT EACH TRIGGER'S REFERENCE IS. The registry declares it
--    (`AUTOMATION_TRIGGERS[].refType`); a producer that writes another pair aims
--    an action at the wrong row, which is why this is a CHECK and not a
--    convention. The window events (engagement drop, schedule gap) carry no
--    reference, like SCHEDULED_TIME. ANOMALY_DETECTED keeps no branch: it has
--    no producer (D-173), so an event for it stays unrepresentable.
-- ---------------------------------------------------------------------------
ALTER TABLE "automation_event" DROP CONSTRAINT "automation_event_ref_matches_trigger";
ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_ref_matches_trigger" CHECK (
  CASE "triggerType"
    WHEN 'SCHEDULED_TIME'            THEN "refType" IS NULL     AND "refId" IS NULL
    WHEN 'CONTENT_APPROVED'          THEN "refType" = 'ContentItem'            AND "refId" IS NOT NULL
    WHEN 'CONTENT_SCHEDULED'         THEN "refType" = 'CalendarSlot'           AND "refId" IS NOT NULL
    WHEN 'POST_PUBLISHED'            THEN "refType" = 'PublishJob'             AND "refId" IS NOT NULL
    WHEN 'ANALYTICS_REFRESHED'       THEN "refType" = 'AnalyticsIngestionRun'  AND "refId" IS NOT NULL
    WHEN 'METRIC_THRESHOLD_CROSSED'  THEN "refType" = 'MetricObservation'      AND "refId" IS NOT NULL
    WHEN 'POST_FAILED'               THEN "refType" = 'PublishAttempt'         AND "refId" IS NOT NULL
    WHEN 'REVIEW_WAITING_24H'        THEN "refType" = 'Approval'               AND "refId" IS NOT NULL
    WHEN 'CAMPAIGN_STARTED'          THEN "refType" = 'Campaign'               AND "refId" IS NOT NULL
    WHEN 'CAMPAIGN_ENDED'            THEN "refType" = 'Campaign'               AND "refId" IS NOT NULL
    WHEN 'WEEKLY_ENGAGEMENT_DROPPED' THEN "refType" IS NULL     AND "refId" IS NULL
    WHEN 'SCHEDULE_GAP'              THEN "refType" IS NULL     AND "refId" IS NULL
    WHEN 'POST_TOP_10_PERCENT'       THEN "refType" = 'ContentItem'            AND "refId" IS NOT NULL
    WHEN 'FACT_EXPIRING'             THEN "refType" = 'BrandKnowledgeItem'     AND "refId" IS NOT NULL
    ELSE FALSE
  END
);

-- ---------------------------------------------------------------------------
-- 2. AN EVENT COMPUTED FROM ONE RULE IS ADDRESSED TO THAT RULE. Every new
--    trigger except POST_FAILED is rule-derived (a due-date scan, an edge state
--    or an evaluation window read off one rule); POST_FAILED is a domain event
--    that belongs to the brand, like POST_PUBLISHED.
-- ---------------------------------------------------------------------------
ALTER TABLE "automation_event" DROP CONSTRAINT "automation_event_rule_addressed_when_derived";
ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_rule_addressed_when_derived" CHECK (
  CASE
    WHEN "triggerType" IN (
      'SCHEDULED_TIME',
      'METRIC_THRESHOLD_CROSSED',
      'REVIEW_WAITING_24H',
      'CAMPAIGN_STARTED',
      'CAMPAIGN_ENDED',
      'WEEKLY_ENGAGEMENT_DROPPED',
      'SCHEDULE_GAP',
      'POST_TOP_10_PERCENT',
      'FACT_EXPIRING'
    ) THEN "ruleId" IS NOT NULL
    ELSE "ruleId" IS NULL
  END
);

-- `automation_event_occurrence_is_timed` is UNCHANGED: only SCHEDULED_TIME
-- carries an `occurrence`; the new triggers carry their identity in `dedupeKey`.

-- ---------------------------------------------------------------------------
-- 3. THE CONFIRMATION BOUNDARY STAYS A DATABASE FACT (D-154). The two G13
--    actions that ask first may not exist on a rule with the confirmation
--    requirement switched off, whatever a future editor offers.
-- ---------------------------------------------------------------------------
ALTER TABLE "automation_rule" DROP CONSTRAINT "automation_rule_external_requires_confirmation";
ALTER TABLE "automation_rule" ADD CONSTRAINT "automation_rule_external_requires_confirmation" CHECK (
  "actionType" NOT IN ('PROPOSE_PUBLISH', 'RETRY_PUBLISH', 'PAUSE_CAMPAIGN')
  OR "requiresConfirmationForExternal" IS TRUE
);

-- ---------------------------------------------------------------------------
-- 4. THE RULE'S TRIGGER STATE. Both NULL for every existing rule, which is what
--    keeps their behaviour exactly as it was.
--
--    `armedAt` — the no-backfill boundary (OD-21): set when a rule is created,
--    enabled or has its trigger settings changed; an event produced before it
--    does not reach the rule. NULL means "no boundary", the pre-2B-3 behaviour.
--
--    `dueWatermark` — the due-date producers' durable cursor (report §12):
--    subjects whose due instant lies after it and not after now are the next
--    ones to evaluate. NULL means "not started"; the producer initialises it
--    from `armedAt` and fires nothing for what was already due.
-- ---------------------------------------------------------------------------
ALTER TABLE "automation_rule" ADD COLUMN "armedAt" TIMESTAMPTZ(6);
ALTER TABLE "automation_rule" ADD COLUMN "dueWatermark" TIMESTAMPTZ(6);
