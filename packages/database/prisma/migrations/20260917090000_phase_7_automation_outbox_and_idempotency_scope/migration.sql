-- ---------------------------------------------------------------------------
-- PHASE 7 REMEDIATION, ROUND 2
--
-- Two unrelated-looking repairs that are the same mistake seen from two sides:
-- a rule the platform declares and does not keep.
--
--   1. FIVE UNIQUE CONSTRAINTS SAID "one key per workspace" WHILE THE SERVICES
--      THEY GUARD HAD ALREADY BEEN NARROWED to "one key per caller, per session,
--      per brand". A constraint wider than the lookup it backs is not a stricter
--      safety net; it is a DIFFERENT rule, and the gap between them is where a
--      second legitimate caller's insert dies on a key they never chose.
--
--   2. `automation_event` — the outbox the automation feature never had. The
--      worker's consumer was complete and NOTHING ENQUEUED TO IT, so every
--      authorable trigger was a promise the product could not keep.
--
-- D-113: ONE EXPLICIT TRANSACTION. Prisma wraps a migration only when the file
-- does not manage its own, and half of this applied is worse than none of it.
-- ---------------------------------------------------------------------------
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. THE IDEMPOTENCY SCOPES.
--
-- Each new index is EXACTLY the identity its service's replay lookup matches on,
-- and no wider. The authorization predicates those lookups also carry — the live
-- BrandScope — are deliberately NOT here: a constraint enforces identity, and
-- authorization is not part of a row's identity.
--
-- ON THE NULLABLE COLUMNS. `createdByUserId` and `generatedByUserId` are
-- nullable, and PostgreSQL treats NULLs as distinct in a unique index — so a
-- keyed row with no author would stop de-duplicating. It cannot arise: every
-- path that supplies an idempotency key supplies an actor with it
-- (`ContentStudioService.draft`, `CampaignService.create`,
-- `AnalyticsInsightService.explain`, `StrategyService`), and a row with a NULL
-- key never collided under the old index either.
-- ---------------------------------------------------------------------------

DROP INDEX "copilot_action_plan_workspaceId_idempotencyKey_key";
CREATE UNIQUE INDEX "copilot_action_plan_workspaceId_sessionId_idempotencyKey_key"
  ON "copilot_action_plan"("workspaceId", "sessionId", "idempotencyKey");

DROP INDEX "content_item_workspaceId_idempotencyKey_key";
CREATE UNIQUE INDEX "content_item_workspaceId_brandId_createdByUserId_idempotenc_key"
  ON "content_item"("workspaceId", "brandId", "createdByUserId", "idempotencyKey");

DROP INDEX "campaign_workspaceId_idempotencyKey_key";
CREATE UNIQUE INDEX "campaign_workspaceId_brandId_createdByUserId_idempotencyKey_key"
  ON "campaign"("workspaceId", "brandId", "createdByUserId", "idempotencyKey");

DROP INDEX "insight_workspaceId_idempotencyKey_key";
CREATE UNIQUE INDEX "insight_workspaceId_brandId_type_generatedByUserId_idempote_key"
  ON "insight"("workspaceId", "brandId", "type", "generatedByUserId", "idempotencyKey");

DROP INDEX "brand_brain_message_workspaceId_idempotencyKey_key";
CREATE UNIQUE INDEX "brand_brain_message_workspaceId_conversationId_idempotencyK_key"
  ON "brand_brain_message"("workspaceId", "conversationId", "idempotencyKey");

-- ---------------------------------------------------------------------------
-- 2. THE AUTOMATION OUTBOX.
-- ---------------------------------------------------------------------------
CREATE TABLE "automation_event" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "triggerType" "AutomationTrigger" NOT NULL,
    "refType" TEXT,
    "refId" UUID,
    "ruleId" UUID,
    "occurrence" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "dispatchedAt" TIMESTAMPTZ(6),
    "deliveredAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "automation_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "automation_event_workspaceId_id_key" ON "automation_event"("workspaceId", "id");
CREATE UNIQUE INDEX "automation_event_workspaceId_dedupeKey_key" ON "automation_event"("workspaceId", "dedupeKey");
CREATE INDEX "automation_event_deliveredAt_createdAt_idx" ON "automation_event"("deliveredAt", "createdAt");
CREATE INDEX "automation_event_workspaceId_brandId_triggerType_idx" ON "automation_event"("workspaceId", "brandId", "triggerType");

-- D-112: EVERY TENANT-TO-TENANT KEY IS COMPOSITE ON `workspaceId`.
ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_rule_fkey"
  FOREIGN KEY ("workspaceId", "ruleId") REFERENCES "automation_rule"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- A PRODUCER THAT NAMES THE WRONG KIND OF ROW IS A DATABASE ERROR.
--
-- The trigger registry declares what each trigger's reference IS, and three
-- automation actions resolve a content item FROM that reference. A producer that
-- wrote `refType = 'ContentItem'` for a published post would aim a content
-- operation at a publish job's id. That is exactly the class P7-R5 and the
-- trigger/action compatibility check already closed inside the engine, so it is
-- closed here too rather than trusted to every future producer.
--
-- `SCHEDULED_TIME` carries no reference at all, and the check says so: both
-- columns must be NULL. Every other trigger must carry BOTH.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- A TIMED OCCURRENCE BELONGS TO A TIMED TRIGGER, AND TO NOTHING ELSE.
--
-- `occurrence` IS the run's bucket for a scheduled rule, and an event of any
-- other kind carrying one would silently re-bucket a run whose identity is its
-- reference — the exact defect P7-R5 closed inside the engine, reintroduced from
-- the producer's side.
-- ---------------------------------------------------------------------------
ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_occurrence_is_timed" CHECK (
  ("triggerType" = 'SCHEDULED_TIME') = ("occurrence" IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- AN EVENT COMPUTED FROM ONE RULE'S CONFIGURATION IS ADDRESSED TO THAT RULE.
--
-- A domain event belongs to the brand: every rule listening for an approval
-- should see the approval, so `ruleId` is NULL. The two rule-derived triggers are
-- the opposite — a schedule and a threshold are read OFF a particular rule, and
-- delivering one to a rule that configured a different hour or a different
-- number would fire a rule whose own settings say it should not run.
-- ---------------------------------------------------------------------------
ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_rule_addressed_when_derived" CHECK (
  CASE
    WHEN "triggerType" IN ('SCHEDULED_TIME', 'METRIC_THRESHOLD_CROSSED') THEN "ruleId" IS NOT NULL
    ELSE "ruleId" IS NULL
  END
);

ALTER TABLE "automation_event" ADD CONSTRAINT "automation_event_ref_matches_trigger" CHECK (
  CASE "triggerType"
    WHEN 'SCHEDULED_TIME'            THEN "refType" IS NULL     AND "refId" IS NULL
    WHEN 'CONTENT_APPROVED'          THEN "refType" = 'ContentItem'            AND "refId" IS NOT NULL
    WHEN 'CONTENT_SCHEDULED'         THEN "refType" = 'CalendarSlot'           AND "refId" IS NOT NULL
    WHEN 'POST_PUBLISHED'            THEN "refType" = 'PublishJob'             AND "refId" IS NOT NULL
    WHEN 'ANALYTICS_REFRESHED'       THEN "refType" = 'AnalyticsIngestionRun'  AND "refId" IS NOT NULL
    WHEN 'METRIC_THRESHOLD_CROSSED'  THEN "refType" = 'MetricObservation'      AND "refId" IS NOT NULL
    ELSE FALSE
  END
);

-- ---------------------------------------------------------------------------
-- ROW-LEVEL SECURITY. ENABLE *AND* FORCE, exactly as every tenant-owned table
-- in this schema: without FORCE the table OWNER bypasses every policy, and the
-- owner is the identity that runs migrations.
-- ---------------------------------------------------------------------------
ALTER TABLE "automation_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_event" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "automation_event"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "automation_event"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "automation_event" TO brandspace_app, brandspace_platform;

COMMIT;
