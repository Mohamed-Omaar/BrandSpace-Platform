-- The platform's own AI provider — the platform-wide spending ceiling (D-573, F-66).
--
-- Reviewed and approved as sent by the owner (2026-10-27), with the decision
-- number filled in. FORWARD-ONLY. No row, policy or grant changes.

-- D-573: platform-wide AI spending ceiling (F-66). In-flight requests carry their
-- estimated provider cost so concurrent requests cannot together pass the ceiling.
ALTER TABLE "ai_request"
  ADD COLUMN "providerCostEstimateMicroMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "ai_request"
  ADD CONSTRAINT "ai_request_provider_cost_estimate_nonnegative"
  CHECK ("providerCostEstimateMicroMinor" >= 0);
-- The ceiling sums this month's requests across all workspaces (the gateway runs on
-- the platform identity, F-68); without this index that is a full scan per request.
CREATE INDEX "ai_request_createdAt_idx" ON "ai_request" ("createdAt");
