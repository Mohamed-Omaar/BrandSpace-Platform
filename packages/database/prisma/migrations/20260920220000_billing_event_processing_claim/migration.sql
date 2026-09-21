-- BILLING INBOX: A PROCESSING CLAIM, AND A RETRY STATE THAT IS NOT "FAILED".
--
-- Two defects found in final review of the Phase 1 settlement fix (D-221, D-222).
--
-- 1. Making an unsettled event retryable gave two concurrent deliveries of the
--    SAME event a way to both observe it as unsettled and both enter settlement.
--    The settlement runs outside the inbox row's transaction — deliberately, so
--    a rolled-back apply still leaves the receipt visible — so nothing was
--    serialising them. `claim_token` and `claimed_at` are the ownership record
--    that does.
--
-- 2. Every exception from the apply phase became FAILED, and FAILED is answered
--    with HTTP 200, so the provider never redelivers. A transient failure was
--    therefore permanent: charged externally, nothing applied locally, and no
--    retry anywhere. RETRYABLE and DEAD_LETTER separate "try again" from
--    "a human must look", which is what docs/BILLING-AND-CREDITS.md §5 has
--    always specified.
--
-- Adding an enum value cannot run inside a transaction block on PostgreSQL
-- versions before 12, and Prisma wraps each migration in one. On 12+ it is
-- allowed, but the new value cannot be USED in the same transaction that adds
-- it. Nothing here uses them, so this is safe; the statements below are
-- deliberately additive only.

ALTER TYPE "BillingEventStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "BillingEventStatus" ADD VALUE IF NOT EXISTS 'RETRYABLE';
ALTER TYPE "BillingEventStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTER';

ALTER TABLE "billing_event" ADD COLUMN "claimToken" UUID;
ALTER TABLE "billing_event" ADD COLUMN "claimedAt" TIMESTAMPTZ(6);

-- Finding a stuck claim, and listing the dead-letter queue for an operator.
CREATE INDEX "billing_event_status_claimedAt_idx" ON "billing_event" ("status", "claimedAt");
