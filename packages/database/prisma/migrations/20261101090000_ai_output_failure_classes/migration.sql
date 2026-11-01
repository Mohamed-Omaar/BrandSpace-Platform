-- PR A (AI correctness; check-up 2026-10-28 H-3, M-12 and the image KNOWN bug).
-- SQL approved by the owner on 2026-11-01, with one change the approval asked
-- for: the last CHECK also admits 'CANCELLED', the status a reply the customer
-- STOPS ends in (PR B); no other ai_request status carries a refusal reason —
-- a budget or platform-ceiling refusal writes no row at all, and a wallet that
-- cannot cover the reservation is recorded as FAILED.
--
-- SCHEMA ONLY, ADDITIVE. Two values on "AiFailureClass" and two NULLABLE
-- columns with CHECKs on "ai_request". Nothing is backfilled; every existing
-- row has NULL in both columns and passes every CHECK. No RLS change:
-- "ai_request" keeps its existing policies.
--
-- WHAT THE NEW VALUES MEAN. OUTPUT_INVALID: the provider answered and the
-- caller refused the output after parsing and validating it. OUTPUT_TRUNCATED:
-- the provider stopped at its length limit or answered with nothing. Both
-- release the reservation and are re-runnable under the same key.
--
-- WHAT THE COLUMNS HOLD. The provider's own error code and a short reason,
-- passed through the shared redaction with prompt text removed, for the
-- Control Center request detail. Never returned by a customer API.
--
-- NOT A SIMPLE ROLLBACK once a row holds a new value: a previous release's
-- Prisma client cannot decode it (docs/OPERATIONS.md §6.3).

ALTER TYPE "AiFailureClass" ADD VALUE IF NOT EXISTS 'OUTPUT_INVALID';
ALTER TYPE "AiFailureClass" ADD VALUE IF NOT EXISTS 'OUTPUT_TRUNCATED';

ALTER TABLE "ai_request" ADD COLUMN "providerErrorCode" TEXT, ADD COLUMN "failureReason" TEXT;

ALTER TABLE "ai_request" ADD CONSTRAINT "ai_request_provider_error_code_shape"
  CHECK ("providerErrorCode" IS NULL OR "providerErrorCode" ~ '^[A-Za-z0-9_.:-]{1,64}$');

ALTER TABLE "ai_request" ADD CONSTRAINT "ai_request_failure_reason_bounded"
  CHECK ("failureReason" IS NULL OR char_length("failureReason") <= 200);

ALTER TABLE "ai_request" ADD CONSTRAINT "ai_request_failure_detail_only_on_failure"
  CHECK (
    ("providerErrorCode" IS NULL AND "failureReason" IS NULL)
    OR "status" IN ('FAILED', 'TIMEOUT', 'MODERATION_BLOCKED', 'CANCELLED')
  );
