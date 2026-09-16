-- ---------------------------------------------------------------------------
-- Phase 7 — Analytics, Intelligence, Copilot and Automations
-- (docs/ROADMAP.md Phase 7, docs/DATABASE.md §4.3, §5.5, §9.1–9.2).
--
-- TWELVE TENANT-OWNED TABLES, ONE NEW COLUMN ON AN EXISTING ONE, AND NOTHING
-- ELSE. No table is dropped, no column is removed, no existing migration is
-- touched: this is additive, and it is safe on a fresh database and on an
-- upgrade from `main` alike.
--
-- WHY `metric_observation` IS ROWS AND NOT A `metrics jsonb` BLOB. docs/DATABASE.md
-- §5.5 sketched one row per subject per window carrying every metric in a JSON
-- object. That shape cannot tell MISSING from ZERO: a provider that does not
-- report `saves` and a provider that reports `saves: 0` differ only by a key's
-- absence, and every `?? 0` in every consumer erases the difference. As one row
-- per metric, a metric nobody reported has NO ROW and there is nothing for a
-- default to fill in. It also makes idempotency a database property —
-- `observationKey` is the conflict target of an `INSERT … ON CONFLICT DO UPDATE`
-- (the D-144 discipline), so two schedulers and a duplicate queue delivery
-- converge on one row instead of racing a read-then-write.
--
-- EVERY FOREIGN KEY TO A TENANT-OWNED PARENT IS COMPOSITE (D-112). There are
-- twenty-eight of them here. A plain key would resolve another workspace's row —
-- PostgreSQL evaluates referential integrity as the table OWNER with RLS
-- bypassed — and the difference between "inserted" and "violates foreign key"
-- would answer "does that id exist?" across the tenant boundary. The Copilot
-- makes that sharper than any previous phase: a model can be talked into naming
-- an id, and these keys are what make a foreign one indistinguishable from a
-- fabricated one.
--
-- EVERY COMPOSITE `SET NULL` NAMES ITS COLUMN (D-114). A bare SET NULL on a
-- composite key nulls EVERY referencing column, `workspaceId` included, and
-- `workspaceId` is NOT NULL — so the delete would fail outright. Prisma has no
-- syntax for the column list; this file carries it, in nine places.
--
-- ONE EXPLICIT TRANSACTION (D-113). Prisma does not wrap a migration file in a
-- transaction, and this one creates types that later statements depend on, so a
-- partial application would leave enums with no table and triggers guarding
-- tables that do not exist. It does NOT lift FORCE RLS anywhere: nothing here
-- reads or rewrites an existing tenant row.
-- ---------------------------------------------------------------------------

BEGIN;

-- CreateEnum
CREATE TYPE "MetricSubjectType" AS ENUM ('POST', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "MetricGranularity" AS ENUM ('HOUR', 'DAY', 'WEEK', 'MONTH', 'LIFETIME');

-- CreateEnum
CREATE TYPE "MetricUnit" AS ENUM ('COUNT', 'RATIO_MILLI', 'SECONDS', 'DELTA');

-- CreateEnum
CREATE TYPE "MetricSourceKind" AS ENUM ('PROVIDER', 'MOCK');

-- CreateEnum
CREATE TYPE "AnalyticsFreshness" AS ENUM ('FRESH', 'AGING', 'STALE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AnalyticsRunKind" AS ENUM ('SCHEDULED', 'BACKFILL', 'MANUAL');

-- CreateEnum
CREATE TYPE "AnalyticsRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED_RATE_LIMITED');

-- CreateEnum
CREATE TYPE "InsightType" AS ENUM ('ANALYTICS_EXPLANATION', 'RECOMMENDATION', 'ANOMALY', 'CONTENT_GAP', 'OPPORTUNITY', 'STRATEGY', 'MONTHLY_PLAN');

-- CreateEnum
CREATE TYPE "InsightStatus" AS ENUM ('NEW', 'SEEN', 'ACCEPTED', 'DISMISSED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "InsightBasis" AS ENUM ('OWN_PERFORMANCE', 'BRAND_CONTEXT', 'CONTENT_HISTORY', 'MIXED');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('METRIC', 'METRIC_COMPARISON', 'BRAND_KNOWLEDGE', 'CONTENT', 'ABSENCE');

-- CreateEnum
CREATE TYPE "CampaignObjective" AS ENUM ('AWARENESS', 'ENGAGEMENT', 'TRAFFIC', 'LEADS', 'RETENTION', 'LAUNCH');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CopilotActionClass" AS ENUM ('READ_ONLY', 'INTERNAL_REVERSIBLE', 'EXTERNAL_OR_DESTRUCTIVE');

-- CreateEnum
CREATE TYPE "CopilotPlanStatus" AS ENUM ('DRAFT', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'EXECUTING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CopilotToolCallStatus" AS ENUM ('PLANNED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REFUSED', 'SKIPPED', 'UNDONE');

-- CreateEnum
CREATE TYPE "CopilotUndoStatus" AS ENUM ('NOT_APPLICABLE', 'AVAILABLE', 'PARTIALLY_UNDONE', 'UNDONE', 'REFUSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CopilotMessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "AutomationTrigger" AS ENUM ('CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED', 'ANALYTICS_REFRESHED', 'ANOMALY_DETECTED', 'METRIC_THRESHOLD_CROSSED', 'SCHEDULED_TIME');

-- CreateEnum
CREATE TYPE "AutomationActionType" AS ENUM ('NOTIFY', 'SUBMIT_FOR_APPROVAL', 'PLACE_ON_CALENDAR', 'PROPOSE_PUBLISH');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'SKIPPED', 'AWAITING_CONFIRMATION', 'BLOCKED_BY_POLICY', 'BLOCKED_BY_AUTHORIZATION', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "content_item" ADD COLUMN     "campaignId" UUID;

-- CreateTable
CREATE TABLE "metric_observation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "socialConnectionId" UUID NOT NULL,
    "provider" "SocialProvider" NOT NULL,
    "subjectType" "MetricSubjectType" NOT NULL,
    "subjectExternalId" TEXT NOT NULL,
    "publishJobId" UUID,
    "contentItemId" UUID,
    "metricKey" TEXT NOT NULL,
    "granularity" "MetricGranularity" NOT NULL,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "value" BIGINT NOT NULL,
    "unit" "MetricUnit" NOT NULL,
    "observedAt" TIMESTAMPTZ(6) NOT NULL,
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceKind" "MetricSourceKind" NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "ingestionRunId" UUID,
    "observationKey" TEXT NOT NULL,

    CONSTRAINT "metric_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_ingestion_cursor" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "socialConnectionId" UUID NOT NULL,
    "provider" "SocialProvider" NOT NULL,
    "subjectType" "MetricSubjectType" NOT NULL,
    "granularity" "MetricGranularity" NOT NULL,
    "lastCoveredPeriodEnd" TIMESTAMPTZ(6),
    "lastSucceededAt" TIMESTAMPTZ(6),
    "lastAttemptedAt" TIMESTAMPTZ(6),
    "backfillCursor" TIMESTAMPTZ(6),
    "backfillCompletedAt" TIMESTAMPTZ(6),
    "nextAttemptAt" TIMESTAMPTZ(6),
    "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureClass" "PublishFailureClass",
    "lastFailureCode" TEXT,
    "freshness" "AnalyticsFreshness" NOT NULL DEFAULT 'UNAVAILABLE',
    "claimedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "analytics_ingestion_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_ingestion_run" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "cursorId" UUID NOT NULL,
    "socialConnectionId" UUID NOT NULL,
    "provider" "SocialProvider" NOT NULL,
    "kind" "AnalyticsRunKind" NOT NULL,
    "status" "AnalyticsRunStatus" NOT NULL DEFAULT 'RUNNING',
    "idempotencyKey" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "windowEnd" TIMESTAMPTZ(6) NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),
    "durationMs" INTEGER,
    "subjectsRequested" INTEGER NOT NULL DEFAULT 0,
    "subjectsAnswered" INTEGER NOT NULL DEFAULT 0,
    "observationsWritten" INTEGER NOT NULL DEFAULT 0,
    "observationsUnchanged" INTEGER NOT NULL DEFAULT 0,
    "failureClass" "PublishFailureClass",
    "failureCode" TEXT,
    "safeSummary" TEXT,
    "retryAfterSeconds" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_ingestion_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "objective" "CampaignObjective" NOT NULL,
    "brief" JSONB,
    "description" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "startDate" DATE,
    "endDate" DATE,
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "strategyInsightId" UUID,
    "ownerUserId" UUID,
    "createdByUserId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "campaignId" UUID,
    "type" "InsightType" NOT NULL,
    "status" "InsightStatus" NOT NULL DEFAULT 'NEW',
    "basis" "InsightBasis" NOT NULL,
    "title" JSONB NOT NULL,
    "body" JSONB NOT NULL,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "comparisonPeriodStart" TIMESTAMPTZ(6),
    "comparisonPeriodEnd" TIMESTAMPTZ(6),
    "aiRequestId" UUID,
    "confidenceMilli" INTEGER,
    "generatedByUserId" UUID,
    "reviewedByUserId" UUID,
    "reviewedAt" TIMESTAMPTZ(6),
    "reviewReason" TEXT,
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "insight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_evidence" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "insightId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "metricObservationId" UUID,
    "knowledgeItemId" UUID,
    "contentItemId" UUID,
    "campaignId" UUID,
    "metricKey" TEXT,
    "value" BIGINT,
    "comparisonValue" BIGINT,
    "changeRatioMilli" INTEGER,
    "unit" "MetricUnit",
    "granularity" "MetricGranularity",
    "periodStart" TIMESTAMPTZ(6),
    "periodEnd" TIMESTAMPTZ(6),
    "comparisonPeriodStart" TIMESTAMPTZ(6),
    "comparisonPeriodEnd" TIMESTAMPTZ(6),
    "subjectType" "MetricSubjectType",
    "subjectExternalId" TEXT,
    "provider" "SocialProvider",
    "observedAt" TIMESTAMPTZ(6),
    "sourceKind" "MetricSourceKind",
    "labelKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_session" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID,
    "userId" UUID NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'general',
    "locale" "Locale" NOT NULL DEFAULT 'EN',
    "title" TEXT,
    "lastMessageAt" TIMESTAMPTZ(6),
    "archivedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "copilot_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_message" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "role" "CopilotMessageRole" NOT NULL,
    "body" TEXT,
    "bodyPurgedAt" TIMESTAMPTZ(6),
    "aiRequestId" UUID,
    "planId" UUID,
    "idempotencyKey" TEXT,
    "correlationId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_action_plan" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID,
    "sessionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "CopilotPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "planVersion" INTEGER NOT NULL DEFAULT 1,
    "planHash" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "highestActionClass" "CopilotActionClass" NOT NULL DEFAULT 'READ_ONLY',
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT true,
    "estimatedCreditsMilli" BIGINT NOT NULL DEFAULT 0,
    "confirmationTokenHash" TEXT,
    "confirmationExpiresAt" TIMESTAMPTZ(6),
    "confirmedAt" TIMESTAMPTZ(6),
    "confirmedByUserId" UUID,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "failureCode" TEXT,
    "undoStatus" "CopilotUndoStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "undoExpiresAt" TIMESTAMPTZ(6),
    "undoneAt" TIMESTAMPTZ(6),
    "undoneByUserId" UUID,
    "undoRefusedCode" TEXT,
    "correlationId" UUID NOT NULL,
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "copilot_action_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_tool_call" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "toolKey" TEXT NOT NULL,
    "actionClass" "CopilotActionClass" NOT NULL,
    "status" "CopilotToolCallStatus" NOT NULL DEFAULT 'PLANNED',
    "argumentsJson" JSONB,
    "resultJson" JSONB,
    "resourceType" TEXT,
    "resourceId" UUID,
    "resourceVersionBefore" INTEGER,
    "resourceVersionAfter" INTEGER,
    "compensation" JSONB,
    "failureCode" TEXT,
    "aiRequestId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "copilot_tool_call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rule" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "triggerType" "AutomationTrigger" NOT NULL,
    "triggerConfig" JSONB NOT NULL DEFAULT '{}',
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actionType" "AutomationActionType" NOT NULL,
    "actionConfig" JSONB NOT NULL DEFAULT '{}',
    "maxRunsPerDay" INTEGER NOT NULL DEFAULT 0,
    "requiresConfirmationForExternal" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID,
    "lastRunAt" TIMESTAMPTZ(6),
    "lastRunStatus" "AutomationRunStatus",
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "automation_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_run" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "triggerType" "AutomationTrigger" NOT NULL,
    "triggerRefType" TEXT,
    "triggerRefId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "conditionsHeld" BOOLEAN,
    "actionType" "AutomationActionType" NOT NULL,
    "actionResult" JSONB,
    "resourceType" TEXT,
    "resourceId" UUID,
    "confirmationTokenHash" TEXT,
    "confirmationExpiresAt" TIMESTAMPTZ(6),
    "confirmedAt" TIMESTAMPTZ(6),
    "confirmedByUserId" UUID,
    "failureCode" TEXT,
    "safeSummary" TEXT,
    "correlationId" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metric_observation_workspaceId_brandId_metricKey_periodStar_idx" ON "metric_observation"("workspaceId", "brandId", "metricKey", "periodStart" DESC);

-- CreateIndex
CREATE INDEX "metric_observation_workspaceId_brandId_subjectType_periodSt_idx" ON "metric_observation"("workspaceId", "brandId", "subjectType", "periodStart" DESC);

-- CreateIndex
CREATE INDEX "metric_observation_workspaceId_socialConnectionId_periodSta_idx" ON "metric_observation"("workspaceId", "socialConnectionId", "periodStart" DESC);

-- CreateIndex
CREATE INDEX "metric_observation_workspaceId_contentItemId_idx" ON "metric_observation"("workspaceId", "contentItemId");

-- CreateIndex
CREATE INDEX "metric_observation_workspaceId_publishJobId_idx" ON "metric_observation"("workspaceId", "publishJobId");

-- CreateIndex
CREATE INDEX "metric_observation_periodStart_idx" ON "metric_observation"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "metric_observation_workspaceId_id_key" ON "metric_observation"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "metric_observation_workspaceId_observationKey_key" ON "metric_observation"("workspaceId", "observationKey");

-- CreateIndex
CREATE INDEX "analytics_ingestion_cursor_workspaceId_brandId_freshness_idx" ON "analytics_ingestion_cursor"("workspaceId", "brandId", "freshness");

-- CreateIndex
CREATE INDEX "analytics_ingestion_cursor_nextAttemptAt_claimedAt_idx" ON "analytics_ingestion_cursor"("nextAttemptAt", "claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_ingestion_cursor_workspaceId_id_key" ON "analytics_ingestion_cursor"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_ingestion_cursor_workspaceId_socialConnectionId_s_key" ON "analytics_ingestion_cursor"("workspaceId", "socialConnectionId", "subjectType", "granularity");

-- CreateIndex
CREATE INDEX "analytics_ingestion_run_workspaceId_brandId_startedAt_idx" ON "analytics_ingestion_run"("workspaceId", "brandId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "analytics_ingestion_run_workspaceId_cursorId_startedAt_idx" ON "analytics_ingestion_run"("workspaceId", "cursorId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "analytics_ingestion_run_startedAt_idx" ON "analytics_ingestion_run"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_ingestion_run_workspaceId_idempotencyKey_key" ON "analytics_ingestion_run"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "campaign_workspaceId_brandId_status_idx" ON "campaign"("workspaceId", "brandId", "status");

-- CreateIndex
CREATE INDEX "campaign_workspaceId_brandId_startDate_endDate_idx" ON "campaign"("workspaceId", "brandId", "startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_workspaceId_id_key" ON "campaign"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_workspaceId_idempotencyKey_key" ON "campaign"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "insight_workspaceId_brandId_type_createdAt_idx" ON "insight"("workspaceId", "brandId", "type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "insight_workspaceId_brandId_status_createdAt_idx" ON "insight"("workspaceId", "brandId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "insight_workspaceId_campaignId_idx" ON "insight"("workspaceId", "campaignId");

-- CreateIndex
CREATE INDEX "insight_expiresAt_idx" ON "insight"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "insight_workspaceId_id_key" ON "insight"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "insight_workspaceId_idempotencyKey_key" ON "insight"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "insight_evidence_workspaceId_insightId_idx" ON "insight_evidence"("workspaceId", "insightId");

-- CreateIndex
CREATE INDEX "insight_evidence_workspaceId_metricObservationId_idx" ON "insight_evidence"("workspaceId", "metricObservationId");

-- CreateIndex
CREATE UNIQUE INDEX "insight_evidence_workspaceId_insightId_ordinal_key" ON "insight_evidence"("workspaceId", "insightId", "ordinal");

-- CreateIndex
CREATE INDEX "copilot_session_workspaceId_userId_lastMessageAt_idx" ON "copilot_session"("workspaceId", "userId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "copilot_session_expiresAt_idx" ON "copilot_session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "copilot_session_workspaceId_id_key" ON "copilot_session"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "copilot_message_workspaceId_sessionId_createdAt_idx" ON "copilot_message"("workspaceId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "copilot_message_expiresAt_idx" ON "copilot_message"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "copilot_message_workspaceId_sessionId_idempotencyKey_key" ON "copilot_message"("workspaceId", "sessionId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "copilot_action_plan_confirmationTokenHash_key" ON "copilot_action_plan"("confirmationTokenHash");

-- CreateIndex
CREATE INDEX "copilot_action_plan_workspaceId_sessionId_createdAt_idx" ON "copilot_action_plan"("workspaceId", "sessionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "copilot_action_plan_workspaceId_status_idx" ON "copilot_action_plan"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "copilot_action_plan_expiresAt_idx" ON "copilot_action_plan"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "copilot_action_plan_workspaceId_id_key" ON "copilot_action_plan"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "copilot_action_plan_workspaceId_idempotencyKey_key" ON "copilot_action_plan"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "copilot_action_plan_workspaceId_sessionId_planVersion_key" ON "copilot_action_plan"("workspaceId", "sessionId", "planVersion");

-- CreateIndex
CREATE INDEX "copilot_tool_call_workspaceId_planId_ordinal_idx" ON "copilot_tool_call"("workspaceId", "planId", "ordinal");

-- CreateIndex
CREATE INDEX "copilot_tool_call_workspaceId_status_idx" ON "copilot_tool_call"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "copilot_tool_call_workspaceId_planId_ordinal_key" ON "copilot_tool_call"("workspaceId", "planId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "copilot_tool_call_workspaceId_idempotencyKey_key" ON "copilot_tool_call"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "automation_rule_workspaceId_brandId_enabled_idx" ON "automation_rule"("workspaceId", "brandId", "enabled");

-- CreateIndex
CREATE INDEX "automation_rule_workspaceId_triggerType_enabled_idx" ON "automation_rule"("workspaceId", "triggerType", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "automation_rule_workspaceId_id_key" ON "automation_rule"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_rule_workspaceId_brandId_name_key" ON "automation_rule"("workspaceId", "brandId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "automation_run_confirmationTokenHash_key" ON "automation_run"("confirmationTokenHash");

-- CreateIndex
CREATE INDEX "automation_run_workspaceId_ruleId_startedAt_idx" ON "automation_run"("workspaceId", "ruleId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "automation_run_workspaceId_brandId_status_idx" ON "automation_run"("workspaceId", "brandId", "status");

-- CreateIndex
CREATE INDEX "automation_run_startedAt_idx" ON "automation_run"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_run_workspaceId_idempotencyKey_key" ON "automation_run"("workspaceId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "content_item" ADD CONSTRAINT "content_item_campaign_fkey" FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "campaign"("workspaceId", "id") ON DELETE SET NULL ("campaignId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "metric_observation" ADD CONSTRAINT "metric_observation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_observation" ADD CONSTRAINT "metric_observation_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_observation" ADD CONSTRAINT "metric_observation_connection_fkey" FOREIGN KEY ("workspaceId", "socialConnectionId") REFERENCES "social_connection"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "metric_observation" ADD CONSTRAINT "metric_observation_job_fkey" FOREIGN KEY ("workspaceId", "publishJobId") REFERENCES "publish_job"("workspaceId", "id") ON DELETE SET NULL ("publishJobId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "metric_observation" ADD CONSTRAINT "metric_observation_item_fkey" FOREIGN KEY ("workspaceId", "contentItemId") REFERENCES "content_item"("workspaceId", "id") ON DELETE SET NULL ("contentItemId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "analytics_ingestion_cursor" ADD CONSTRAINT "analytics_ingestion_cursor_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_ingestion_cursor" ADD CONSTRAINT "analytics_cursor_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_ingestion_cursor" ADD CONSTRAINT "analytics_cursor_connection_fkey" FOREIGN KEY ("workspaceId", "socialConnectionId") REFERENCES "social_connection"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "analytics_ingestion_run" ADD CONSTRAINT "analytics_ingestion_run_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_ingestion_run" ADD CONSTRAINT "analytics_run_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_ingestion_run" ADD CONSTRAINT "analytics_run_cursor_fkey" FOREIGN KEY ("workspaceId", "cursorId") REFERENCES "analytics_ingestion_cursor"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "analytics_ingestion_run" ADD CONSTRAINT "analytics_run_connection_fkey" FOREIGN KEY ("workspaceId", "socialConnectionId") REFERENCES "social_connection"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight" ADD CONSTRAINT "insight_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight" ADD CONSTRAINT "insight_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight" ADD CONSTRAINT "insight_campaign_fkey" FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "campaign"("workspaceId", "id") ON DELETE SET NULL ("campaignId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_insight_fkey" FOREIGN KEY ("workspaceId", "insightId") REFERENCES "insight"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_observation_fkey" FOREIGN KEY ("workspaceId", "metricObservationId") REFERENCES "metric_observation"("workspaceId", "id") ON DELETE SET NULL ("metricObservationId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_knowledge_fkey" FOREIGN KEY ("workspaceId", "knowledgeItemId") REFERENCES "brand_knowledge_item"("workspaceId", "id") ON DELETE SET NULL ("knowledgeItemId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_item_fkey" FOREIGN KEY ("workspaceId", "contentItemId") REFERENCES "content_item"("workspaceId", "id") ON DELETE SET NULL ("contentItemId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_campaign_fkey" FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "campaign"("workspaceId", "id") ON DELETE SET NULL ("campaignId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "copilot_session" ADD CONSTRAINT "copilot_session_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_session" ADD CONSTRAINT "copilot_session_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_message" ADD CONSTRAINT "copilot_message_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_message" ADD CONSTRAINT "copilot_message_session_fkey" FOREIGN KEY ("workspaceId", "sessionId") REFERENCES "copilot_session"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "copilot_message" ADD CONSTRAINT "copilot_message_plan_fkey" FOREIGN KEY ("workspaceId", "planId") REFERENCES "copilot_action_plan"("workspaceId", "id") ON DELETE SET NULL ("planId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "copilot_action_plan" ADD CONSTRAINT "copilot_action_plan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_action_plan" ADD CONSTRAINT "copilot_plan_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_action_plan" ADD CONSTRAINT "copilot_plan_session_fkey" FOREIGN KEY ("workspaceId", "sessionId") REFERENCES "copilot_session"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "copilot_tool_call" ADD CONSTRAINT "copilot_tool_call_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_tool_call" ADD CONSTRAINT "copilot_tool_call_plan_fkey" FOREIGN KEY ("workspaceId", "planId") REFERENCES "copilot_action_plan"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "copilot_tool_call" ADD CONSTRAINT "copilot_tool_call_session_fkey" FOREIGN KEY ("workspaceId", "sessionId") REFERENCES "copilot_session"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_rule" ADD CONSTRAINT "automation_rule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rule" ADD CONSTRAINT "automation_rule_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_brand_fkey" FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_rule_fkey" FOREIGN KEY ("workspaceId", "ruleId") REFERENCES "automation_rule"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;



-- ---------------------------------------------------------------------------
-- BRAND BRAIN'S WRITE-BACK PATH — the placeholder D-64 left open, closed here.
--
-- Phase 5A deliberately stopped short of Analytics -> Brand Brain: "D-64's
-- return path needs analytics, which is Phase 7. The schema carries it — memory
-- layer, origin, confidence, evidence — so it is not a retrofit"
-- (docs/ROADMAP.md). This is that phase, and it EXTENDS the existing governance
-- rather than building a second one.
--
-- THE KEY DECISION, and the reason no new table appears here: an inferred
-- learning enters Brand Brain as a `brand_knowledge_candidate`, through the SAME
-- review / accept / dismiss lifecycle a document candidate goes through, judged
-- by the same `brand_brain.review` permission, recorded in the same version
-- history. A parallel approval system would be a second answer to "who decides
-- what is true about this brand", and D-65 has exactly one.
--
-- Three columns and one relaxation:
--   - `sourceDocumentId` becomes NULLABLE. An analytics learning has no file.
--     MATCH SIMPLE exempts the null case, so every candidate that DOES name a
--     document is still checked by the composite key it already had.
--   - `sourceKind` says which kind it is, and therefore what it may BECOME: a
--     document candidate lands as DOCUMENT knowledge once a human accepts it; a
--     learning stays AI_INFERRED, because a human agreeing that an inference
--     looks right does not turn it into a statement the brand made about itself.
--   - `insightId` points at the evidence, so a reviewer retraces the inference
--     instead of being asked to trust a sentence (D-65 reproducibility).
--   - `conflictsWithItemId` records that the inference DISAGREES with something a
--     human wrote. The conflict is surfaced and the human item is never touched.
-- ---------------------------------------------------------------------------

CREATE TYPE "BrandCandidateSource" AS ENUM ('DOCUMENT', 'ANALYTICS');

ALTER TABLE "brand_knowledge_candidate"
  ADD COLUMN "conflictsWithItemId" UUID,
  ADD COLUMN "insightId"           UUID,
  ADD COLUMN "sourceKind" "BrandCandidateSource" NOT NULL DEFAULT 'DOCUMENT',
  ALTER COLUMN "sourceDocumentId" DROP NOT NULL;

CREATE INDEX "brand_knowledge_candidate_workspaceId_sourceKind_status_idx"
  ON "brand_knowledge_candidate" ("workspaceId", "sourceKind", "status");

-- COLUMN-SCOPED SET NULL (D-114), twice more. A bare SET NULL on either of these
-- composite keys would null `workspaceId` as well, and `workspaceId` is NOT NULL.
ALTER TABLE "brand_knowledge_candidate"
  ADD CONSTRAINT "brand_knowledge_candidate_insight_fkey"
  FOREIGN KEY ("workspaceId", "insightId") REFERENCES "insight"("workspaceId", "id")
  ON DELETE SET NULL ("insightId") ON UPDATE NO ACTION;

ALTER TABLE "brand_knowledge_candidate"
  ADD CONSTRAINT "brand_knowledge_candidate_conflict_fkey"
  FOREIGN KEY ("workspaceId", "conflictsWithItemId")
  REFERENCES "brand_knowledge_item"("workspaceId", "id")
  ON DELETE SET NULL ("conflictsWithItemId") ON UPDATE NO ACTION;

-- A DOCUMENT CANDIDATE STILL HAS A DOCUMENT, and an ANALYTICS candidate still has
-- an insight. Dropping the NOT NULL made a document candidate with no document
-- expressible for the first time; this makes it unrepresentable again, for the
-- only kind where it was ever meaningful.
ALTER TABLE "brand_knowledge_candidate"
  ADD CONSTRAINT "brand_knowledge_candidate_source_is_present"
  CHECK (
    ("sourceKind" = 'DOCUMENT'  AND "sourceDocumentId" IS NOT NULL)
    OR ("sourceKind" = 'ANALYTICS' AND "insightId" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- CHECK CONSTRAINTS — the invariants that must hold whatever code writes the
-- row. Each one closes a way a future call site could make the data lie.
-- ---------------------------------------------------------------------------

-- A window has to be a window. A period whose end precedes its start would make
-- every comparison and every aggregate quietly wrong rather than loudly broken.
ALTER TABLE "metric_observation"
  ADD CONSTRAINT "metric_observation_period_ordered"
  CHECK ("periodEnd" >= "periodStart");

-- A COUNT and a duration cannot be negative; a DELTA can, because losing
-- followers is a real measurement. Stated as a constraint rather than trusted to
-- an adapter, because a provider returning -5 impressions is a parsing bug and
-- this is where it should stop.
ALTER TABLE "metric_observation"
  ADD CONSTRAINT "metric_observation_value_sign"
  CHECK ("unit" = 'DELTA' OR "value" >= 0);

-- A rate is parts per mille and cannot exceed 1000 unless it is a DELTA.
ALTER TABLE "metric_observation"
  ADD CONSTRAINT "metric_observation_ratio_bounds"
  CHECK ("unit" <> 'RATIO_MILLI' OR ("value" >= 0 AND "value" <= 1000));

-- A post-level reading names the post; an account-level reading names the
-- account. Neither may point at OUR content rows unless it is about a post.
ALTER TABLE "metric_observation"
  ADD CONSTRAINT "metric_observation_account_has_no_post"
  CHECK ("subjectType" = 'POST' OR ("publishJobId" IS NULL AND "contentItemId" IS NULL));

ALTER TABLE "analytics_ingestion_run"
  ADD CONSTRAINT "analytics_run_window_ordered"
  CHECK ("windowEnd" >= "windowStart");

-- The same bound `publish_attempt.safeSummary` carries, for the same reason: it
-- exists so a raw provider body cannot be dropped in here by a future call site.
ALTER TABLE "analytics_ingestion_run"
  ADD CONSTRAINT "analytics_run_summary_bounded"
  CHECK ("safeSummary" IS NULL OR length("safeSummary") <= 500);

-- A finished run has a terminal status, and a running one has no finish time.
ALTER TABLE "analytics_ingestion_run"
  ADD CONSTRAINT "analytics_run_finished_is_terminal"
  CHECK (
    ("status" = 'RUNNING' AND "finishedAt" IS NULL)
    OR ("status" <> 'RUNNING' AND "finishedAt" IS NOT NULL)
  );

ALTER TABLE "campaign"
  ADD CONSTRAINT "campaign_dates_ordered"
  CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate");

ALTER TABLE "campaign"
  ADD CONSTRAINT "campaign_version_positive"
  CHECK ("version" >= 1);

ALTER TABLE "insight"
  ADD CONSTRAINT "insight_period_ordered"
  CHECK ("periodEnd" >= "periodStart");

-- Per mille, like every other confidence in this schema.
ALTER TABLE "insight"
  ADD CONSTRAINT "insight_confidence_bounds"
  CHECK ("confidenceMilli" IS NULL OR ("confidenceMilli" >= 0 AND "confidenceMilli" <= 1000));

ALTER TABLE "insight_evidence"
  ADD CONSTRAINT "insight_evidence_ordinal_positive"
  CHECK ("ordinal" >= 1);

-- THE ANTI-FABRICATION CONSTRAINT, and the one worth reading twice.
--
-- A METRIC or METRIC_COMPARISON evidence row must carry a metric key, a value
-- and a window — because that is what the UI renders instead of trusting the
-- model's sentence. An evidence row with a label and no measurement would be a
-- citation pointing at nothing, which is exactly the shape a fabricated one
-- takes.
ALTER TABLE "insight_evidence"
  ADD CONSTRAINT "insight_evidence_metric_is_measured"
  CHECK (
    "kind" NOT IN ('METRIC', 'METRIC_COMPARISON')
    OR ("metricKey" IS NOT NULL AND "value" IS NOT NULL
        AND "unit" IS NOT NULL AND "periodStart" IS NOT NULL AND "periodEnd" IS NOT NULL)
  );

-- And a COMPARISON must have something to compare with.
ALTER TABLE "insight_evidence"
  ADD CONSTRAINT "insight_evidence_comparison_has_two_sides"
  CHECK (
    "kind" <> 'METRIC_COMPARISON'
    OR ("comparisonValue" IS NOT NULL
        AND "comparisonPeriodStart" IS NOT NULL AND "comparisonPeriodEnd" IS NOT NULL)
  );

-- A purged body says so, and a body that is still there has no purge stamp.
-- The same shape `brand_brain_message` and `content_variant` carry, so a purged
-- turn is visibly purged rather than silently blank.
ALTER TABLE "copilot_message"
  ADD CONSTRAINT "copilot_message_purge_is_recorded"
  CHECK ("bodyPurgedAt" IS NULL OR "body" IS NULL);

ALTER TABLE "copilot_action_plan"
  ADD CONSTRAINT "copilot_plan_version_positive"
  CHECK ("planVersion" >= 1);

ALTER TABLE "copilot_action_plan"
  ADD CONSTRAINT "copilot_plan_estimate_not_negative"
  CHECK ("estimatedCreditsMilli" >= 0);

-- CLAUDE.md §2.5 AND A-17, AS A DATABASE CONSTRAINT.
--
-- "The AI Copilot may propose and preview these actions but must never execute
-- them silently." A plan whose strictest step leaves the platform or destroys
-- something may not exist with `requiresConfirmation` false — so no future
-- screen, no crafted payload and no well-meaning refactor can produce one.
ALTER TABLE "copilot_action_plan"
  ADD CONSTRAINT "copilot_plan_external_requires_confirmation"
  CHECK ("highestActionClass" <> 'EXTERNAL_OR_DESTRUCTIVE' OR "requiresConfirmation" IS TRUE);

-- A CONFIRMED plan was confirmed by somebody, at a time. "Confirmed by nobody"
-- is the state a replay or a forged transition would leave behind.
ALTER TABLE "copilot_action_plan"
  ADD CONSTRAINT "copilot_plan_confirmation_is_attributable"
  CHECK (
    "confirmedAt" IS NULL
    OR ("confirmedByUserId" IS NOT NULL AND "confirmationTokenHash" IS NOT NULL)
  );

-- A plan that has not been confirmed has not executed. This is the ordering the
-- whole confirmation contract rests on, stated where it cannot be skipped.
ALTER TABLE "copilot_action_plan"
  ADD CONSTRAINT "copilot_plan_execution_follows_confirmation"
  CHECK (
    "startedAt" IS NULL
    OR "requiresConfirmation" IS FALSE
    OR "confirmedAt" IS NOT NULL
  );

ALTER TABLE "copilot_tool_call"
  ADD CONSTRAINT "copilot_tool_call_ordinal_positive"
  CHECK ("ordinal" >= 1);

ALTER TABLE "automation_rule"
  ADD CONSTRAINT "automation_rule_runs_not_negative"
  CHECK ("maxRunsPerDay" >= 0 AND "runCount" >= 0 AND "version" >= 1);

-- THE SAME §2.5 RULE, REACHED BY THE OTHER DOOR.
--
-- An automation is not a way around the Copilot's confirmation boundary. A rule
-- whose action leaves the platform may not exist with the confirmation
-- requirement switched off, whatever a future rule editor offers.
ALTER TABLE "automation_rule"
  ADD CONSTRAINT "automation_rule_external_requires_confirmation"
  CHECK ("actionType" <> 'PROPOSE_PUBLISH' OR "requiresConfirmationForExternal" IS TRUE);

ALTER TABLE "automation_run"
  ADD CONSTRAINT "automation_run_summary_bounded"
  CHECK ("safeSummary" IS NULL OR length("safeSummary") <= 500);

ALTER TABLE "automation_run"
  ADD CONSTRAINT "automation_run_confirmation_is_attributable"
  CHECK (
    "confirmedAt" IS NULL
    OR ("confirmedByUserId" IS NOT NULL AND "confirmationTokenHash" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- IMMUTABILITY WHERE THE ROW IS EVIDENCE.
--
-- `insight_evidence` is what a customer is shown INSTEAD of trusting the
-- model's sentence, and `analytics_ingestion_run` is what an operator reads to
-- find out what a provider actually did. A record that can be edited afterwards
-- is not evidence — the reasoning `publish_attempt` and `ai_usage_ledger`
-- already carry — so both are append-only, enforced by a trigger rather than by
-- convention.
--
-- A RUN IS ALLOWED EXACTLY ONE TRANSITION: out of RUNNING, once, into a terminal
-- status with its counters and its finish time. Everything else raises.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.insight_evidence_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'insight_evidence is append-only: a citation that can be rewritten after the '
    'fact is not evidence (attempted %)', lower(TG_OP)
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION app.insight_evidence_is_append_only() IS
  'Phase 7: the evidence behind an insight may be inserted and read, never rewritten.';

CREATE TRIGGER insight_evidence_no_update
  BEFORE UPDATE ON "insight_evidence"
  FOR EACH ROW EXECUTE FUNCTION app.insight_evidence_is_append_only();

CREATE OR REPLACE FUNCTION app.analytics_run_completes_once()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" <> 'RUNNING' THEN
    RAISE EXCEPTION
      'analytics_ingestion_run % is already terminal (%): a completed run is a record, not a draft',
      OLD."id", OLD."status"
      USING ERRCODE = '42501';
  END IF;

  -- The identity of the run may never move. Only the outcome may be written.
  IF NEW."id" <> OLD."id"
     OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."brandId" <> OLD."brandId"
     OR NEW."cursorId" <> OLD."cursorId"
     OR NEW."socialConnectionId" <> OLD."socialConnectionId"
     OR NEW."kind" <> OLD."kind"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."windowStart" <> OLD."windowStart"
     OR NEW."windowEnd" <> OLD."windowEnd"
     OR NEW."startedAt" <> OLD."startedAt" THEN
    RAISE EXCEPTION
      'analytics_ingestion_run % may record its outcome, never re-describe what it was',
      OLD."id"
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION app.analytics_run_completes_once() IS
  'Phase 7: an ingestion run moves out of RUNNING exactly once and never re-describes itself.';

CREATE TRIGGER analytics_run_completes_once
  BEFORE UPDATE ON "analytics_ingestion_run"
  FOR EACH ROW EXECUTE FUNCTION app.analytics_run_completes_once();

-- ---------------------------------------------------------------------------
-- A CONFIRMATION IS SINGLE-USE, AND THE DATABASE SAYS SO.
--
-- The application consumes a confirmation with a conditional UPDATE on
-- `confirmedAt IS NULL`, which is already a database primitive rather than a
-- read-then-write. This trigger is the backstop for the other half: once a plan
-- is confirmed, its hash and its steps may never move. Without it, a caller
-- could confirm a cheap plan and then rewrite its steps into an expensive one
-- while the confirmation still reads as valid — the exact attack the plan hash
-- exists to prevent, performed one layer below it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.copilot_plan_is_frozen_once_confirmed()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."confirmedAt" IS NOT NULL THEN
    IF NEW."planHash" <> OLD."planHash"
       OR NEW."steps"::text <> OLD."steps"::text
       OR NEW."highestActionClass" <> OLD."highestActionClass"
       OR NEW."planVersion" <> OLD."planVersion"
       OR NEW."requiresConfirmation" <> OLD."requiresConfirmation" THEN
      RAISE EXCEPTION
        'copilot_action_plan % was confirmed as % and its steps may not change afterwards',
        OLD."id", OLD."planHash"
        USING ERRCODE = '42501';
    END IF;
    -- And a confirmation may not be re-issued onto a plan that already has one.
    IF NEW."confirmedAt" <> OLD."confirmedAt"
       OR NEW."confirmationTokenHash" IS DISTINCT FROM OLD."confirmationTokenHash" THEN
      RAISE EXCEPTION
        'copilot_action_plan % is already confirmed: a confirmation is single-use',
        OLD."id"
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION app.copilot_plan_is_frozen_once_confirmed() IS
  'Phase 7: a confirmed action plan is immutable — changing the plan must require a new confirmation.';

CREATE TRIGGER copilot_plan_frozen_once_confirmed
  BEFORE UPDATE ON "copilot_action_plan"
  FOR EACH ROW EXECUTE FUNCTION app.copilot_plan_is_frozen_once_confirmed();

CREATE OR REPLACE FUNCTION app.automation_run_confirmation_is_single_use()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."confirmedAt" IS NOT NULL
     AND (NEW."confirmedAt" <> OLD."confirmedAt"
          OR NEW."confirmationTokenHash" IS DISTINCT FROM OLD."confirmationTokenHash") THEN
    RAISE EXCEPTION
      'automation_run % is already confirmed: a confirmation is single-use', OLD."id"
      USING ERRCODE = '42501';
  END IF;
  -- THE ACTION A RUN PROPOSED MAY NOT CHANGE AFTER A HUMAN AGREED TO IT.
  --
  -- `resourceId` IS THE THING THAT WAS CONFIRMED — the content item a person
  -- looked at before saying yes — and it is compared with no null-guard on
  -- purpose: moving it from NOTHING to SOMETHING after the fact is re-aiming
  -- too, and would let a confirmation for an unspecified target be spent on a
  -- specific one.
  --
  -- WHAT A CONFIRMED RUN PRODUCED GOES IN `actionResult`, NOT HERE. Sharing one
  -- column between "what the human agreed to" and "what came out of it" is what
  -- would force this constraint to be loosened, so the two are kept apart.
  IF OLD."confirmedAt" IS NOT NULL
     AND (NEW."actionType" <> OLD."actionType"
          OR NEW."ruleId" <> OLD."ruleId"
          OR NEW."resourceId" IS DISTINCT FROM OLD."resourceId") THEN
    RAISE EXCEPTION
      'automation_run % was confirmed for a specific action and may not be re-aimed', OLD."id"
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION app.automation_run_confirmation_is_single_use() IS
  'Phase 7: a confirmed automation run may not be re-confirmed or re-aimed at another action.';

CREATE TRIGGER automation_run_confirmation_single_use
  BEFORE UPDATE ON "automation_run"
  FOR EACH ROW EXECUTE FUNCTION app.automation_run_confirmation_is_single_use();

-- ---------------------------------------------------------------------------
-- ROW-LEVEL SECURITY. ENABLED AND FORCED on all twelve.
--
-- FORCE matters as much as ENABLE: without it the policy does not apply to the
-- table's OWNER, and a migration or a maintenance statement running as owner
-- would see every tenant at once (D-113).
--
-- WRITTEN OUT ONE TABLE AT A TIME, not generated in a DO loop. The D-29 gate
-- READS THIS FILE AS TEXT to prove every tenant-owned table has its policy, and
-- a loop that builds the statements with `format()` is invisible to it — the
-- policies would exist and the gate that exists to prove they exist would have
-- nothing to read. Verbosity a machine can check beats brevity it cannot.
-- ---------------------------------------------------------------------------

ALTER TABLE "metric_observation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "metric_observation" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "metric_observation"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "metric_observation"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "metric_observation" TO brandspace_app, brandspace_platform;

ALTER TABLE "analytics_ingestion_cursor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analytics_ingestion_cursor" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "analytics_ingestion_cursor"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "analytics_ingestion_cursor"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "analytics_ingestion_cursor" TO brandspace_app, brandspace_platform;

ALTER TABLE "analytics_ingestion_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analytics_ingestion_run" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "analytics_ingestion_run"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "analytics_ingestion_run"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "analytics_ingestion_run" TO brandspace_app, brandspace_platform;

ALTER TABLE "campaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaign" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "campaign"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "campaign"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "campaign" TO brandspace_app, brandspace_platform;

ALTER TABLE "insight" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "insight" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "insight"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "insight"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "insight" TO brandspace_app, brandspace_platform;

ALTER TABLE "insight_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "insight_evidence" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "insight_evidence"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "insight_evidence"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "insight_evidence" TO brandspace_app, brandspace_platform;

ALTER TABLE "copilot_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_session" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "copilot_session"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "copilot_session"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "copilot_session" TO brandspace_app, brandspace_platform;

ALTER TABLE "copilot_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_message" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "copilot_message"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "copilot_message"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "copilot_message" TO brandspace_app, brandspace_platform;

ALTER TABLE "copilot_action_plan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_action_plan" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "copilot_action_plan"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "copilot_action_plan"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "copilot_action_plan" TO brandspace_app, brandspace_platform;

ALTER TABLE "copilot_tool_call" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copilot_tool_call" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "copilot_tool_call"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "copilot_tool_call"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "copilot_tool_call" TO brandspace_app, brandspace_platform;

ALTER TABLE "automation_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_rule" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "automation_rule"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "automation_rule"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "automation_rule" TO brandspace_app, brandspace_platform;

ALTER TABLE "automation_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_run" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "automation_run"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "automation_run"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "automation_run" TO brandspace_app, brandspace_platform;

-- ---------------------------------------------------------------------------
-- IMMUTABILITY IS A TRIGGER; NON-DELETABILITY IS A PRIVILEGE.
--
-- The distinction Phase 6 established. A BEFORE DELETE trigger fires for a
-- CASCADED delete too, so guarding deletion with a trigger would make deleting
-- an insight fail because of its own evidence. The privilege is revoked instead:
-- the tenant role cannot delete an evidence row directly, and a cascade from the
-- insight it belongs to still works because a cascade runs as the table owner.
--
-- The PLATFORM identity keeps DELETE: erasure on request is a platform
-- operation and must remain possible.
-- ---------------------------------------------------------------------------

REVOKE DELETE ON "insight_evidence" FROM brandspace_app;
REVOKE DELETE ON "analytics_ingestion_run" FROM brandspace_app;

-- ---------------------------------------------------------------------------
-- ASSERT what was just done, rather than trusting it.
--
-- A migration that says it enabled RLS and did not is the worst possible
-- outcome: every later isolation test passes for the wrong reason.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'metric_observation', 'analytics_ingestion_cursor', 'analytics_ingestion_run',
    'campaign', 'insight', 'insight_evidence',
    'copilot_session', 'copilot_message', 'copilot_action_plan', 'copilot_tool_call',
    'automation_rule', 'automation_run'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
       WHERE oid = format('%I', t)::regclass
         AND relrowsecurity IS TRUE
         AND relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '% must have RLS ENABLED and FORCED after this migration', t;
    END IF;
  END LOOP;
END $$;

-- AND THAT THE REVOKE SURVIVED THE GRANT. The two are order-dependent and a few
-- lines apart: a GRANT after the REVOKE would silently restore the privilege and
-- the evidence trail would be tenant-deletable with nothing saying so.
DO $$
BEGIN
  IF has_table_privilege('brandspace_app', 'insight_evidence', 'DELETE') THEN
    RAISE EXCEPTION
      'brandspace_app must NOT hold DELETE on insight_evidence: a citation is removable '
      'only by a cascade from the insight it belongs to';
  END IF;
  IF NOT has_table_privilege('brandspace_app', 'insight_evidence', 'INSERT') THEN
    RAISE EXCEPTION 'brandspace_app must still be able to INSERT evidence';
  END IF;
  IF has_table_privilege('brandspace_app', 'analytics_ingestion_run', 'DELETE') THEN
    RAISE EXCEPTION
      'brandspace_app must NOT hold DELETE on analytics_ingestion_run: the ingestion '
      'record is operator evidence and is pruned by the platform identity';
  END IF;
END $$;

-- EVERY COMPOSITE SET NULL NAMES ITS COLUMN (D-114). A bare one would null
-- `workspaceId` too and the delete would fail at runtime rather than here, in
-- production, on a customer deleting a campaign. Asserted from the catalogue so
-- the property is proven rather than reviewed.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(c.conname, ', ') INTO bad
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.confdeltype = 'n'                     -- ON DELETE SET NULL
     AND array_length(c.conkey, 1) > 1           -- composite
     AND c.confdelsetcols IS NULL                -- ... with no column list
     AND c.conname IN (
       'content_item_campaign_fkey', 'metric_observation_job_fkey',
       'metric_observation_item_fkey', 'insight_campaign_fkey',
       'insight_evidence_observation_fkey', 'insight_evidence_knowledge_fkey',
       'insight_evidence_item_fkey', 'insight_evidence_campaign_fkey',
       'copilot_message_plan_fkey'
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'these composite SET NULL foreign keys have no column list and would null workspaceId (D-114): %',
      bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Admit `analytics`, `copilot` and `automations` to the tenant
-- entitlement-catalogue projection.
--
-- The allowed-domain CHECK is a closed list on purpose — projecting a domain
-- makes it tenant-readable, which is a decision and not a default.
--
-- These three earn it the way `content` and `publishing` did: the customer's own
-- screens state and enforce these values. The analytics page has to say what
-- "stale" means before it labels anything stale; the export control has to know
-- the maximum window BEFORE the customer picks a longer one; the Copilot has to
-- state a plan ceiling it is actually enforcing; the automation editor has to
-- show the daily run ceiling it will apply. A dashboard that restated any of it
-- would be a second setting that drifts from the first (CLAUDE.md §2.2).
--
-- THEY CARRY NO CREDENTIAL, NO PROVIDER AND NO PRICE. Model routing stays in
-- `ai.routing`, credit costs in `ai.credit-rules`, plan limits in `plans` — none
-- of which is projected.
-- ---------------------------------------------------------------------------

ALTER TABLE "entitlement_catalogue_snapshot"
  DROP CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains";

ALTER TABLE "entitlement_catalogue_snapshot"
  ADD CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains"
  CHECK ("domain" IN (
    'entitlements', 'plans', 'feature-flags', 'credits',
    'brand-brain', 'assets', 'content', 'publishing',
    'analytics', 'copilot', 'automations'
  ));

COMMIT;
