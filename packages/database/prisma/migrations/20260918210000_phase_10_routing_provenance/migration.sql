-- Phase 10 — routing provenance on the AI request row.
--
-- WHICH CAPABILITY, AND WHICH LAYER ANSWERED.
--
-- After Phase 10 a request can be routed two ways: a task rule somebody wrote,
-- or the capability layer with a profile ranking the catalogue. "Which model
-- served this" is therefore only half the answer — an operator looking at a
-- surprising bill needs to know whether a human chose that model or a ranking
-- derived it, and which capability constrained the choice.
--
-- BOTH NULLABLE, with no backfill. A row written before this migration was
-- routed by a task rule under the pre-Phase-10 resolver; inventing a capability
-- for it would be asserting something nobody recorded. Null means exactly that.
ALTER TABLE "ai_request" ADD COLUMN "routingCapability" TEXT;
ALTER TABLE "ai_request" ADD COLUMN "routingProfile"    TEXT;
