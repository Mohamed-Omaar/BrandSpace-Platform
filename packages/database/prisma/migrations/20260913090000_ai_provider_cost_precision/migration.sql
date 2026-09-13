-- Provider cost is recorded in MICRO-MINOR units, not minor units.
--
-- WHY THIS CORRECTION EXISTS. 20260909100000 gave `providerCostMinor` the type
-- INTEGER, following the field name in docs/AI-GATEWAY.md §7.2. A minor unit
-- cannot hold what providers actually charge: a text model at $0.15 per million
-- input tokens costs 0.015 of a cent per thousand tokens, and as an integer
-- count of cents that is zero. Every text request would have recorded a
-- provider cost of nothing, and the margin reporting those columns exist to
-- feed would have shown infinite margin on every row — the one number the
-- margin floor of §7.2 is there to catch.
--
-- One micro-minor is a millionth of a minor unit, which holds that price
-- exactly as the integer 15000. BIGINT because a month of a busy workspace's
-- requests at that scale outgrows INTEGER.
--
-- Existing values are multiplied rather than reinterpreted, so a row written
-- as 4 minor units stays worth 4 minor units.

-- ai_request ----------------------------------------------------------------

ALTER TABLE "ai_request" DROP CONSTRAINT "ai_request_provider_cost_nonnegative";

ALTER TABLE "ai_request" RENAME COLUMN "providerCostMinor" TO "providerCostMicroMinor";

ALTER TABLE "ai_request"
  ALTER COLUMN "providerCostMicroMinor" DROP DEFAULT,
  ALTER COLUMN "providerCostMicroMinor" TYPE BIGINT
    USING ("providerCostMicroMinor"::BIGINT * 1000000),
  ALTER COLUMN "providerCostMicroMinor" SET DEFAULT 0;

ALTER TABLE "ai_request"
  ADD CONSTRAINT "ai_request_provider_cost_nonnegative"
    CHECK ("providerCostMicroMinor" >= 0);

-- ai_usage_ledger -----------------------------------------------------------

ALTER TABLE "ai_usage_ledger" DROP CONSTRAINT "ai_usage_ledger_amounts_nonnegative";

ALTER TABLE "ai_usage_ledger" RENAME COLUMN "providerCostMinor" TO "providerCostMicroMinor";

ALTER TABLE "ai_usage_ledger"
  ALTER COLUMN "providerCostMicroMinor" DROP DEFAULT,
  ALTER COLUMN "providerCostMicroMinor" TYPE BIGINT
    USING ("providerCostMicroMinor"::BIGINT * 1000000),
  ALTER COLUMN "providerCostMicroMinor" SET DEFAULT 0;

ALTER TABLE "ai_usage_ledger"
  ADD CONSTRAINT "ai_usage_ledger_amounts_nonnegative"
    CHECK ("providerCostMicroMinor" >= 0 AND "creditsChargedMilli" >= 0);
