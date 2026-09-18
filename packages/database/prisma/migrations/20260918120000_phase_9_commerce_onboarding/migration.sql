-- ---------------------------------------------------------------------------
-- Phase 9 — Commerce & Onboarding
-- (docs/ROADMAP.md Phase 9, docs/BILLING-AND-CREDITS.md, docs/SECURITY.md §38).
--
-- EIGHT TENANT-OWNED TABLES, TWO PLATFORM-OWNED, THREE IDENTITY-SCOPED, AND
-- ADDITIVE COLUMNS ON TWO EXISTING TABLES. Nothing is dropped, no column is
-- removed, no earlier migration is touched: safe on an empty database and on an
-- upgrade from `main` alike.
--
-- MONEY IS `BIGINT` MINOR UNITS AND CARRIES ITS OWN SCALE. Every monetary row
-- stores `currency` AND `currencyScale`, because 1000 is 10.00 in SAR and 1.000
-- in KWD — and because an issued invoice is a historical fact that a later
-- catalogue edit must not silently re-denominate. Three of the seven launch
-- currencies (KWD, BHD, OMR) have three decimal digits; a schema that assumed
-- two would be wrong about the price in three markets.
--
-- EVERY FOREIGN KEY TO A TENANT-OWNED PARENT IS COMPOSITE (D-112), and every
-- composite `SET NULL` names its column (D-114): a bare SET NULL on a composite
-- key would try to null `workspaceId` too, which is NOT NULL, and the delete
-- would fail at runtime rather than at review.
--
-- THE WEBHOOK INBOX IS PLATFORM-OWNED, and that is the point. A provider event
-- arrives before anyone knows whose it is, so the workspace is DERIVED by
-- looking the provider's customer id up in `billing_profile` — never read from
-- the event body. One workspace must not be able to count another's payment
-- events, so the tenant role has no access to `billing_event` at all.
--
-- INVOICE NUMBERS COME FROM A LOCKED COUNTER, not from a sequence. Sequences
-- are not transactional: a rolled-back issue would leave a permanent gap in an
-- accounting series that several of the markets this platform sells in expect
-- to be gapless. `app.allocate_invoice_number()` takes a row lock inside the
-- caller's own transaction, so two simultaneous issues get two different
-- numbers and a rollback returns the number to the pool. Issuance is a SYSTEM
-- operation and the function is platform-only: a customer has no business
-- advancing the accounting series of the seller.
--
-- NO PAYMENT PROVIDER IS NAMED ANYWHERE IN THIS MIGRATION (D-204). Provider
-- references are opaque strings; no column is a credential, and a hosted
-- checkout means no card data can reach any of these tables.
-- ---------------------------------------------------------------------------

BEGIN;

-- CreateEnum
CREATE TYPE "CheckoutPurpose" AS ENUM ('SUBSCRIPTION', 'CREDIT_PACK');

-- CreateEnum
CREATE TYPE "CheckoutSessionStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');

-- CreateEnum
CREATE TYPE "InvoiceTaxMode" AS ENUM ('NONE', 'EXCLUSIVE', 'INCLUSIVE');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('SUBSCRIPTION', 'CREDIT_PACK', 'PRORATION', 'SEAT', 'ADDON', 'DISCOUNT');

-- CreateEnum
CREATE TYPE "CreditNoteStatus" AS ENUM ('DRAFT', 'ISSUED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "CreditPackPurchaseStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "BillingEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'STALE', 'UNRESOLVED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SubscriptionStatus" ADD VALUE 'CHECKOUT_PENDING';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'SUSPENDED';

-- AlterTable
ALTER TABLE "workspace_subscription" ADD COLUMN     "cancelRequestedAt" TIMESTAMPTZ(6),
ADD COLUMN     "graceEndsAt" TIMESTAMPTZ(6),
ADD COLUMN     "lastBillingEventId" UUID,
ADD COLUMN     "lastEventAt" TIMESTAMPTZ(6),
ADD COLUMN     "pastDueSince" TIMESTAMPTZ(6),
ADD COLUMN     "pendingCheckoutSessionId" UUID,
ADD COLUMN     "providerKey" TEXT,
ADD COLUMN     "providerSubscriptionId" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "billing_profile" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "billingEmail" TEXT NOT NULL,
    "legalName" TEXT,
    "taxId" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "country" CHAR(2) NOT NULL,
    "providerKey" TEXT,
    "providerCustomerId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "billing_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_session" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "purpose" "CheckoutPurpose" NOT NULL,
    "status" "CheckoutSessionStatus" NOT NULL DEFAULT 'PENDING',
    "planKey" TEXT,
    "billingInterval" "BillingInterval",
    "packKey" TEXT,
    "currency" CHAR(3) NOT NULL,
    "currencyScale" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL,
    "planVersionId" UUID,
    "commerceVersionId" UUID,
    "providerKey" TEXT NOT NULL,
    "providerSessionId" TEXT,
    "returnUrl" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "completedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "checkout_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "number" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "currencyScale" INTEGER NOT NULL,
    "subtotalMinor" BIGINT NOT NULL,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL,
    "amountPaidMinor" BIGINT NOT NULL DEFAULT 0,
    "creditedMinor" BIGINT NOT NULL DEFAULT 0,
    "taxMode" "InvoiceTaxMode" NOT NULL DEFAULT 'NONE',
    "taxRateBasisPoints" INTEGER NOT NULL DEFAULT 0,
    "taxPolicyKey" TEXT,
    "periodStart" TIMESTAMPTZ(6),
    "periodEnd" TIMESTAMPTZ(6),
    "issuedAt" TIMESTAMPTZ(6),
    "dueAt" TIMESTAMPTZ(6),
    "paidAt" TIMESTAMPTZ(6),
    "voidedAt" TIMESTAMPTZ(6),
    "commercialSnapshot" JSONB NOT NULL,
    "partiesSnapshot" JSONB NOT NULL,
    "providerKey" TEXT,
    "providerInvoiceId" TEXT,
    "providerPaymentId" TEXT,
    "checkoutSessionId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "kind" "InvoiceLineKind" NOT NULL,
    "description" JSONB NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitAmountMinor" BIGINT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "taxAmountMinor" BIGINT NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "number" TEXT,
    "status" "CreditNoteStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "currencyScale" INTEGER NOT NULL,
    "subtotalMinor" BIGINT NOT NULL,
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(6),
    "refundedAt" TIMESTAMPTZ(6),
    "providerRefundId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdByUserId" UUID,
    "createdByPlatformUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credit_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_line" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "creditNoteId" UUID NOT NULL,
    "invoiceLineId" UUID,
    "description" JSONB NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "amountMinor" BIGINT NOT NULL,
    "taxAmountMinor" BIGINT NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_note_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempt" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "invoiceId" UUID,
    "checkoutSessionId" UUID,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "currency" CHAR(3) NOT NULL,
    "currencyScale" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "failureCode" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "providerPaymentId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "attemptedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(6),
    "nextRetryAt" TIMESTAMPTZ(6),

    CONSTRAINT "payment_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_pack_purchase" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "packKey" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "currencyScale" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "CreditPackPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "checkoutSessionId" UUID,
    "invoiceId" UUID,
    "creditGrantId" UUID,
    "providerPaymentId" TEXT,
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credit_pack_purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_event" (
    "id" UUID NOT NULL,
    "providerKey" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "status" "BillingEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "resolvedWorkspaceId" UUID,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "billing_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_number_sequence" (
    "prefix" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_number_sequence_pkey" PRIMARY KEY ("prefix","year")
);

-- CreateTable
CREATE TABLE "email_verification_token" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,

    CONSTRAINT "email_verification_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_legal_acceptance" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "documentKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "user_legal_acceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_mfa_recovery_code" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_mfa_recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_profile_workspaceId_key" ON "billing_profile"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_profile_providerKey_providerCustomerId_key" ON "billing_profile"("providerKey", "providerCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_profile_workspaceId_id_key" ON "billing_profile"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "checkout_session_workspaceId_status_idx" ON "checkout_session"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "checkout_session_status_expiresAt_idx" ON "checkout_session"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_session_workspaceId_idempotencyKey_key" ON "checkout_session"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_session_providerKey_providerSessionId_key" ON "checkout_session"("providerKey", "providerSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_session_workspaceId_id_key" ON "checkout_session"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_number_key" ON "invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_checkoutSessionId_key" ON "invoice"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "invoice_workspaceId_status_issuedAt_idx" ON "invoice"("workspaceId", "status", "issuedAt");

-- CreateIndex
CREATE INDEX "invoice_workspaceId_createdAt_idx" ON "invoice"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_workspaceId_id_key" ON "invoice"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_workspaceId_checkoutSessionId_key" ON "invoice"("workspaceId", "checkoutSessionId");

-- CreateIndex
CREATE INDEX "invoice_line_workspaceId_invoiceId_sortOrder_idx" ON "invoice_line"("workspaceId", "invoiceId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_workspaceId_id_key" ON "invoice_line"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_number_key" ON "credit_note"("number");

-- CreateIndex
CREATE INDEX "credit_note_workspaceId_invoiceId_idx" ON "credit_note"("workspaceId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_workspaceId_idempotencyKey_key" ON "credit_note"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_workspaceId_id_key" ON "credit_note"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "credit_note_line_workspaceId_creditNoteId_sortOrder_idx" ON "credit_note_line"("workspaceId", "creditNoteId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_line_workspaceId_id_key" ON "credit_note_line"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "payment_attempt_workspaceId_invoiceId_idx" ON "payment_attempt"("workspaceId", "invoiceId");

-- CreateIndex
CREATE INDEX "payment_attempt_status_nextRetryAt_idx" ON "payment_attempt"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_workspaceId_idempotencyKey_key" ON "payment_attempt"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempt_workspaceId_id_key" ON "payment_attempt"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_pack_purchase_checkoutSessionId_key" ON "credit_pack_purchase"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_pack_purchase_invoiceId_key" ON "credit_pack_purchase"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_pack_purchase_creditGrantId_key" ON "credit_pack_purchase"("creditGrantId");

-- CreateIndex
CREATE INDEX "credit_pack_purchase_workspaceId_status_idx" ON "credit_pack_purchase"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "credit_pack_purchase_workspaceId_id_key" ON "credit_pack_purchase"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_pack_purchase_workspaceId_checkoutSessionId_key" ON "credit_pack_purchase"("workspaceId", "checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_pack_purchase_workspaceId_invoiceId_key" ON "credit_pack_purchase"("workspaceId", "invoiceId");

-- CreateIndex
CREATE INDEX "billing_event_status_receivedAt_idx" ON "billing_event"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "billing_event_resolvedWorkspaceId_occurredAt_idx" ON "billing_event"("resolvedWorkspaceId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_event_providerKey_externalEventId_key" ON "billing_event"("providerKey", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_token_tokenHash_key" ON "email_verification_token"("tokenHash");

-- CreateIndex
CREATE INDEX "email_verification_token_userId_usedAt_idx" ON "email_verification_token"("userId", "usedAt");

-- CreateIndex
CREATE INDEX "email_verification_token_expiresAt_idx" ON "email_verification_token"("expiresAt");

-- CreateIndex
CREATE INDEX "user_legal_acceptance_userId_idx" ON "user_legal_acceptance"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_legal_acceptance_userId_documentKey_version_key" ON "user_legal_acceptance"("userId", "documentKey", "version");

-- CreateIndex
CREATE INDEX "user_mfa_recovery_code_userId_usedAt_idx" ON "user_mfa_recovery_code"("userId", "usedAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_mfa_recovery_code_userId_codeHash_key" ON "user_mfa_recovery_code"("userId", "codeHash");

-- CreateIndex
CREATE INDEX "workspace_subscription_status_graceEndsAt_idx" ON "workspace_subscription"("status", "graceEndsAt");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_subscription_providerKey_providerSubscriptionId_key" ON "workspace_subscription"("providerKey", "providerSubscriptionId");

-- AddForeignKey
ALTER TABLE "billing_profile" ADD CONSTRAINT "billing_profile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_session" ADD CONSTRAINT "checkout_session_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_session" ADD CONSTRAINT "checkout_session_profile_fkey" FOREIGN KEY ("workspaceId") REFERENCES "billing_profile"("workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_profile_fkey" FOREIGN KEY ("workspaceId") REFERENCES "billing_profile"("workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_checkout_fkey" FOREIGN KEY ("workspaceId", "checkoutSessionId") REFERENCES "checkout_session"("workspaceId", "id") ON DELETE SET NULL ("checkoutSessionId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_fkey" FOREIGN KEY ("workspaceId", "invoiceId") REFERENCES "invoice"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note" ADD CONSTRAINT "credit_note_invoice_fkey" FOREIGN KEY ("workspaceId", "invoiceId") REFERENCES "invoice"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "credit_note_line" ADD CONSTRAINT "credit_note_line_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_line" ADD CONSTRAINT "credit_note_line_note_fkey" FOREIGN KEY ("workspaceId", "creditNoteId") REFERENCES "credit_note"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_invoice_fkey" FOREIGN KEY ("workspaceId", "invoiceId") REFERENCES "invoice"("workspaceId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_checkout_fkey" FOREIGN KEY ("workspaceId", "checkoutSessionId") REFERENCES "checkout_session"("workspaceId", "id") ON DELETE SET NULL ("checkoutSessionId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "credit_pack_purchase" ADD CONSTRAINT "credit_pack_purchase_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_pack_purchase" ADD CONSTRAINT "credit_pack_purchase_checkout_fkey" FOREIGN KEY ("workspaceId", "checkoutSessionId") REFERENCES "checkout_session"("workspaceId", "id") ON DELETE SET NULL ("checkoutSessionId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "credit_pack_purchase" ADD CONSTRAINT "credit_pack_purchase_invoice_fkey" FOREIGN KEY ("workspaceId", "invoiceId") REFERENCES "invoice"("workspaceId", "id") ON DELETE SET NULL ("invoiceId") ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "email_verification_token" ADD CONSTRAINT "email_verification_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_legal_acceptance" ADD CONSTRAINT "user_legal_acceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_mfa_recovery_code" ADD CONSTRAINT "user_mfa_recovery_code_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- TENANT ISOLATION (CLAUDE.md §2.1, D-29)
--
-- ENABLE + FORCE on every tenant-owned table. FORCE matters: without it the
-- table OWNER bypasses RLS silently, so a seed script would be exempt from the
-- rule it is seeding data under.
-- ---------------------------------------------------------------------------

ALTER TABLE "billing_profile"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_profile"       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "checkout_session"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "checkout_session"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "invoice"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice"               FORCE  ROW LEVEL SECURITY;
ALTER TABLE "invoice_line"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_line"          FORCE  ROW LEVEL SECURITY;
ALTER TABLE "credit_note"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_note"           FORCE  ROW LEVEL SECURITY;
ALTER TABLE "credit_note_line"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_note_line"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "payment_attempt"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_attempt"       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "credit_pack_purchase"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_pack_purchase"  FORCE  ROW LEVEL SECURITY;

-- The three identity-scoped tables. A verification token, a legal acceptance
-- and an MFA recovery code belong to a PERSON, before and independently of any
-- workspace — exactly like `password_reset_token`, and protected the same way.
ALTER TABLE "email_verification_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_verification_token" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "user_legal_acceptance"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_legal_acceptance"    FORCE  ROW LEVEL SECURITY;
ALTER TABLE "user_mfa_recovery_code"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_mfa_recovery_code"   FORCE  ROW LEVEL SECURITY;

-- The two platform-owned tables.
ALTER TABLE "billing_event"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_event"            FORCE  ROW LEVEL SECURITY;
ALTER TABLE "invoice_number_sequence"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_number_sequence"  FORCE  ROW LEVEL SECURITY;

-- Tenant policies -----------------------------------------------------------

CREATE POLICY tenant_isolation ON "billing_profile"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "checkout_session"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "invoice"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "invoice_line"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "credit_note"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "credit_note_line"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "payment_attempt"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "credit_pack_purchase"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Identity-scoped tables are reachable ONLY from the authentication and
-- onboarding paths, which run with NO workspace context. Inside a workspace the
-- tables are empty for the tenant role, so a member of workspace A cannot read
-- verification tokens, legal acceptances or recovery codes at all — theirs or
-- anyone else's. This is the `customer_session` rule, applied for the same
-- reason.
CREATE POLICY tenant_isolation ON "email_verification_token"
  TO brandspace_app
  USING      (app.current_workspace_id() IS NULL)
  WITH CHECK (app.current_workspace_id() IS NULL);

CREATE POLICY tenant_isolation ON "user_legal_acceptance"
  TO brandspace_app
  USING      (app.current_workspace_id() IS NULL)
  WITH CHECK (app.current_workspace_id() IS NULL);

CREATE POLICY tenant_isolation ON "user_mfa_recovery_code"
  TO brandspace_app
  USING      (app.current_workspace_id() IS NULL)
  WITH CHECK (app.current_workspace_id() IS NULL);

-- Platform policies ---------------------------------------------------------

CREATE POLICY platform_access ON "billing_profile"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "checkout_session"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "invoice"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "invoice_line"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "credit_note"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "credit_note_line"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "payment_attempt"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "credit_pack_purchase"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "email_verification_token"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "user_legal_acceptance"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "user_mfa_recovery_code"
  TO brandspace_platform USING (true) WITH CHECK (true);

-- PLATFORM-OWNED: the tenant role gets nothing at all -------------------------
--
-- Not "filtered access" — none. A workspace must not be able to read, count or
-- infer another workspace's payment events, and must not be able to read or
-- rewrite the seller's invoice counter.
CREATE POLICY platform_only ON "billing_event"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_only ON "invoice_number_sequence"
  TO brandspace_platform USING (true) WITH CHECK (true);


REVOKE ALL ON "billing_event"           FROM brandspace_app;
REVOKE ALL ON "invoice_number_sequence" FROM brandspace_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_event"           TO brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_number_sequence" TO brandspace_platform;

GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_profile"          TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "checkout_session"         TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice"                  TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_line"             TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "credit_note"              TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "credit_note_line"         TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_attempt"          TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "credit_pack_purchase"     TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_verification_token" TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_legal_acceptance"    TO brandspace_app, brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_mfa_recovery_code"   TO brandspace_app, brandspace_platform;

-- ---------------------------------------------------------------------------
-- COMMERCIAL INVARIANTS THE DATABASE ENFORCES
--
-- Each of these is a rule the application also applies. They are here as well
-- because a rule that lives only in application code is a rule a future caller,
-- a script or a direct write can skip — and these are about money.
-- ---------------------------------------------------------------------------

-- A checkout is for exactly one thing. Both set, or neither, would make the
-- amount unattributable to what was bought.
ALTER TABLE "checkout_session"
  ADD CONSTRAINT "checkout_session_one_subject" CHECK (
    ("purpose" = 'SUBSCRIPTION' AND "planKey" IS NOT NULL AND "billingInterval" IS NOT NULL AND "packKey" IS NULL)
    OR
    ("purpose" = 'CREDIT_PACK'  AND "packKey" IS NOT NULL AND "planKey" IS NULL AND "billingInterval" IS NULL)
  );

-- Amounts are never negative on a checkout, and the total is the sum we agreed.
ALTER TABLE "checkout_session"
  ADD CONSTRAINT "checkout_session_amounts_sane" CHECK (
    "amountMinor" >= 0 AND "taxMinor" >= 0 AND "totalMinor" = "amountMinor" + "taxMinor"
  );

-- A currency's scale is a small non-negative integer, everywhere it is stored.
ALTER TABLE "checkout_session"
  ADD CONSTRAINT "checkout_session_scale_sane" CHECK ("currencyScale" BETWEEN 0 AND 6);
ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_scale_sane" CHECK ("currencyScale" BETWEEN 0 AND 6);
ALTER TABLE "credit_note"
  ADD CONSTRAINT "credit_note_scale_sane" CHECK ("currencyScale" BETWEEN 0 AND 6);
ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_scale_sane" CHECK ("currencyScale" BETWEEN 0 AND 6);
ALTER TABLE "credit_pack_purchase"
  ADD CONSTRAINT "credit_pack_purchase_scale_sane" CHECK ("currencyScale" BETWEEN 0 AND 6);

-- An invoice's own arithmetic. `total` is not a number a caller may choose
-- independently of the parts it is made of.
ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_totals_sane" CHECK (
    "subtotalMinor" >= 0
    AND "discountMinor" >= 0
    AND "taxMinor" >= 0
    AND "amountPaidMinor" >= 0
    AND "creditedMinor" >= 0
    AND "totalMinor" = "subtotalMinor" - "discountMinor" + "taxMinor"
  );

-- AN ISSUED INVOICE HAS A NUMBER, and a numbered invoice has been issued. The
-- two facts are the same fact, and a document with one but not the other is not
-- a commercial record.
ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_issued_has_number" CHECK (
    ("status" = 'DRAFT' AND "number" IS NULL AND "issuedAt" IS NULL)
    OR
    ("status" <> 'DRAFT' AND "number" IS NOT NULL AND "issuedAt" IS NOT NULL)
  );

-- Credits given back never exceed what was invoiced.
ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_credited_within_total" CHECK ("creditedMinor" <= "totalMinor");

ALTER TABLE "credit_note"
  ADD CONSTRAINT "credit_note_totals_sane" CHECK (
    "subtotalMinor" >= 0 AND "taxMinor" >= 0 AND "totalMinor" = "subtotalMinor" + "taxMinor"
  );

-- A pack purchase buys a positive number of credits at a non-negative price,
-- and CANNOT be COMPLETED without naming the one grant it produced. That column
-- is the idempotency proof: it is what makes "paid once, granted once" a
-- database fact rather than a worker's good intentions (D-196, §37).
ALTER TABLE "credit_pack_purchase"
  ADD CONSTRAINT "credit_pack_purchase_sane" CHECK (
    "credits" > 0
    AND "amountMinor" >= 0
    AND ("status" <> 'COMPLETED' OR "creditGrantId" IS NOT NULL)
  );

ALTER TABLE "payment_attempt"
  ADD CONSTRAINT "payment_attempt_amount_sane" CHECK ("amountMinor" >= 0 AND "attemptNumber" >= 1);

ALTER TABLE "invoice_line"
  ADD CONSTRAINT "invoice_line_amount_sane" CHECK ("quantity" >= 1 AND "taxAmountMinor" >= 0);

-- A verification token is single-use and time-bound: `usedAt` is set by a
-- conditional UPDATE, never cleared.
ALTER TABLE "email_verification_token"
  ADD CONSTRAINT "email_verification_token_used_after_created"
  CHECK ("usedAt" IS NULL OR "usedAt" >= "createdAt");

-- The projection may now carry the commercial catalogue. A CHECK rather than a
-- convention: a future caller cannot copy `integrations.payment` here by
-- mistake, and `commerce` names no provider and holds no credential.
ALTER TABLE "entitlement_catalogue_snapshot"
  DROP CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains";

ALTER TABLE "entitlement_catalogue_snapshot"
  ADD CONSTRAINT "entitlement_catalogue_snapshot_allowed_domains"
  CHECK ("domain" IN (
    'entitlements', 'plans', 'feature-flags', 'credits',
    'brand-brain', 'assets', 'content', 'publishing',
    'analytics', 'copilot', 'automations', 'commerce'
  ));

-- ---------------------------------------------------------------------------
-- INVOICE NUMBER ALLOCATION — concurrency-safe, transactional, platform-only
--
-- WHO ISSUES AN INVOICE. The system does, in response to an authoritative
-- provider event — never a customer clicking something. Issuance therefore runs
-- on the PLATFORM connection, in one transaction that both allocates the number
-- and writes the document, and the allocator is an ordinary SECURITY INVOKER
-- function that the `platform_only` policy already admits.
--
-- IT IS DELIBERATELY NOT `SECURITY DEFINER`. An earlier draft made it one so the
-- tenant role could allocate, which required a second policy naming the schema
-- owner — and the D-29 gate refused it, correctly: a platform-owned table with a
-- policy for any role other than `brandspace_platform` is a privilege-escalation
-- path waiting to be found. The tenant role now has no EXECUTE on this function
-- and no access to the counter, which is a stronger property than the one that
-- was being worked around.
--
-- `FOR UPDATE` semantics come from `INSERT ... ON CONFLICT DO UPDATE`, which
-- takes a row lock. Two simultaneous issues therefore receive two different
-- numbers — the property §30 of the Phase 9 brief requires, and one that a
-- `SELECT max(...) + 1` cannot provide at any isolation level a busy
-- application actually runs at.
--
-- A DATABASE SEQUENCE WOULD NOT DO. Sequences are not transactional: a rolled
-- back issue would leave a permanent gap in an accounting series that several
-- of the markets this platform sells in expect to be gapless.
--
-- `search_path` is pinned so a caller cannot shadow `pg_catalog` with a
-- temporary table and change what the function body means.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.allocate_invoice_number(p_prefix text, p_year integer, p_padding integer)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_next integer;
BEGIN
  IF p_prefix IS NULL OR length(p_prefix) = 0 OR length(p_prefix) > 8 THEN
    RAISE EXCEPTION 'invoice number prefix must be 1..8 characters';
  END IF;
  IF p_padding < 4 OR p_padding > 12 THEN
    RAISE EXCEPTION 'invoice number padding must be 4..12';
  END IF;

  -- One row per (prefix, year). The INSERT establishes it; the UPDATE advances
  -- it under a row lock. Both are in the caller's transaction, so a rollback
  -- returns the number to the pool and the series stays gapless.
  INSERT INTO public.invoice_number_sequence AS s ("prefix", "year", "lastValue", "updatedAt")
  VALUES (p_prefix, p_year, 1, now())
  ON CONFLICT ("prefix", "year") DO UPDATE
    SET "lastValue" = s."lastValue" + 1,
        "updatedAt" = now()
  RETURNING s."lastValue" INTO v_next;

  RETURN p_prefix || '-' || p_year::text || '-' || lpad(v_next::text, p_padding, '0');
END;
$$;

-- The tenant role is NOT granted execute. An invoice number is the accounting
-- series of the seller, and a customer has no business advancing it.
REVOKE ALL ON FUNCTION app.allocate_invoice_number(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.allocate_invoice_number(text, integer, integer)
  TO brandspace_platform;

COMMENT ON FUNCTION app.allocate_invoice_number(text, integer, integer) IS
  'Allocates the next invoice number in a (prefix, year) series under a row lock, '
  'inside the transaction of the caller. Platform-only: the tenant role has neither '
  'EXECUTE on this function nor any privilege on the counter it advances.';

COMMIT;
