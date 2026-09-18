-- Phase 10 — Integrations.
--
-- ONE TABLE, AND IT HOLDS OBSERVATIONS RATHER THAN SETTINGS.
--
-- Which provider is configured, with which settings and which credential
-- references, stays in the configuration service: versioned, validated,
-- activatable and rollback-able, exactly as Phase 2A built it. Putting it in a
-- table here would have been a second configuration system, which Phase 10 §3
-- explicitly forbids.
--
-- What this table holds is the other kind of fact. "The credential worked at
-- 14:02" is not a setting somebody chose, it is something that happened — and
-- versioning an observation alongside the settings would turn every health
-- check into a configuration change with an author and an activation.
--
-- PLATFORM-OWNED, with no tenant access at all. A row names a platform
-- credential reference and whether it works. One workspace being able to count
-- BrandSpace's provider failures would be a disclosure in itself, so the
-- policy admits `brandspace_platform` and nobody else.
--
-- NO SECRET IS IN HERE. `message` is written by an adapter for an operator to
-- read, and the adapter contract requires it to be free of credentials and raw
-- provider errors. The redaction layer runs over it as well.

CREATE TYPE "IntegrationCheckOutcome" AS ENUM ('OK', 'FAILED', 'NOT_CONFIGURED', 'REFUSED');

CREATE TABLE "integration_health_check" (
    "id"                        UUID         NOT NULL,
    "category"                  TEXT         NOT NULL,
    "providerKey"               TEXT         NOT NULL,
    "environment"               "DeploymentEnvironment" NOT NULL,
    "outcome"                   "IntegrationCheckOutcome" NOT NULL,
    "latencyMs"                 INTEGER,
    "message"                   TEXT         NOT NULL,
    "requestedByPlatformUserId" UUID,
    "checkedAt"                 TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_health_check_pkey" PRIMARY KEY ("id")
);

-- The Hub asks one question constantly: what is the latest result for this
-- provider in this environment? This index is that question.
CREATE INDEX "integration_health_check_lookup_idx"
    ON "integration_health_check"("category", "providerKey", "environment", "checkedAt" DESC);
CREATE INDEX "integration_health_check_checkedAt_idx"
    ON "integration_health_check"("checkedAt");

-- SET NULL rather than CASCADE: an operator leaving the company must not erase
-- the record that a production credential was verified.
ALTER TABLE "integration_health_check"
    ADD CONSTRAINT "integration_health_check_requestedByPlatformUserId_fkey"
    FOREIGN KEY ("requestedByPlatformUserId") REFERENCES "platform_user"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "integration_health_check" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_health_check" FORCE  ROW LEVEL SECURITY;

CREATE POLICY platform_only ON "integration_health_check"
  TO brandspace_platform USING (true) WITH CHECK (true);

REVOKE ALL ON "integration_health_check" FROM brandspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_health_check" TO brandspace_platform;
