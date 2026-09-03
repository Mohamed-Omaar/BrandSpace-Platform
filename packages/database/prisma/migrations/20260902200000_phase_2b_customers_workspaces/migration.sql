-- ===========================================================================
-- Phase 2B — customers, workspaces, customer authentication, invitations,
-- entitlement overrides and the credit ledger.
--
-- Structure of this file:
--   1. Schema (generated from prisma/schema.prisma)
--   2. Row-level security for every new table
--   3. Constraints that encode business rules (docs/DATABASE.md §12)
--   4. Immutability triggers for the ledger
--
-- SECURITY NOTES
--
-- Every new tenant-owned table repeats the Phase 1 pattern exactly: ENABLE and
-- FORCE row-level security, a `tenant_isolation` policy naming ONLY
-- `brandspace_app`, and a `platform_access` policy naming ONLY
-- `brandspace_platform`. Neither role has BYPASSRLS and neither policy is
-- granted to PUBLIC, so a blanket GRANT added later still yields zero rows.
--
-- `customer_session` and `password_reset_token` carry no `workspaceId` because a
-- User is a global identity and the workspace is chosen AFTER authentication.
-- They are still RLS-protected: their policy makes them readable ONLY with no
-- workspace context — that is, from the authentication path — so a member
-- acting inside workspace A cannot read session or reset rows at all, and
-- certainly not another tenant's.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------
-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "OverrideStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "CreditTransactionType" AS ENUM ('PLAN_GRANT', 'PROMOTIONAL_GRANT', 'ADMIN_ADJUSTMENT', 'RESERVATION', 'RESERVATION_RELEASE', 'USAGE_CHARGE', 'REFUND', 'EXPIRY', 'RESET');

-- CreateEnum
CREATE TYPE "EmailMessageStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "WorkspaceStatus" ADD VALUE 'ARCHIVED';

-- AlterTable
ALTER TABLE "workspace" ADD COLUMN     "archivedAt" TIMESTAMPTZ(6),
ADD COLUMN     "lastActivityAt" TIMESTAMPTZ(6),
ADD COLUMN     "lockVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "planAssignedAt" TIMESTAMPTZ(6),
ADD COLUMN     "planAssignedByPlatformUserId" UUID,
ADD COLUMN     "planKey" TEXT,
ADD COLUMN     "statusChangedAt" TIMESTAMPTZ(6),
ADD COLUMN     "statusChangedByPlatformUserId" UUID,
ADD COLUMN     "statusReason" TEXT;

-- CreateTable
CREATE TABLE "customer_session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "activeWorkspaceId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "absoluteExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "customer_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "roleId" UUID NOT NULL,
    "brandScope" UUID[],
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "revokedReason" TEXT,
    "invitedByUserId" UUID,
    "invitedByPlatformUserId" UUID,
    "acceptedByUserId" UUID,
    "supersededByInvitationId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_override" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "featureKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "limitValue" INTEGER,
    "reason" TEXT NOT NULL,
    "grantedByPlatformUserId" UUID NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveUntil" TIMESTAMPTZ(6),
    "status" "OverrideStatus" NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspace_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_wallet" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "balanceMilliCredits" BIGINT NOT NULL DEFAULT 0,
    "reservedMilliCredits" BIGINT NOT NULL DEFAULT 0,
    "lifetimeGrantedMilliCredits" BIGINT NOT NULL DEFAULT 0,
    "lifetimeConsumedMilliCredits" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credit_wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_transaction" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "amountMilliCredits" BIGINT NOT NULL,
    "balanceAfterMilliCredits" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_message" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "toEmail" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "locale" "Locale" NOT NULL DEFAULT 'AR',
    "variables" JSONB,
    "status" "EmailMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "sentAt" TIMESTAMPTZ(6),
    "failedAt" TIMESTAMPTZ(6),
    "failReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_session_tokenHash_key" ON "customer_session"("tokenHash");

-- CreateIndex
CREATE INDEX "customer_session_userId_revokedAt_idx" ON "customer_session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "customer_session_expiresAt_idx" ON "customer_session"("expiresAt");

-- CreateIndex
CREATE INDEX "customer_session_activeWorkspaceId_idx" ON "customer_session"("activeWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_token_tokenHash_key" ON "password_reset_token"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_token_userId_usedAt_idx" ON "password_reset_token"("userId", "usedAt");

-- CreateIndex
CREATE INDEX "password_reset_token_expiresAt_idx" ON "password_reset_token"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_tokenHash_key" ON "invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "invitation_workspaceId_status_idx" ON "invitation"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "invitation_workspaceId_email_idx" ON "invitation"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "invitation_expiresAt_idx" ON "invitation"("expiresAt");

-- CreateIndex
CREATE INDEX "workspace_override_workspaceId_featureKey_idx" ON "workspace_override"("workspaceId", "featureKey");

-- CreateIndex
CREATE INDEX "workspace_override_effectiveUntil_idx" ON "workspace_override"("effectiveUntil");

-- CreateIndex
CREATE UNIQUE INDEX "credit_wallet_workspaceId_key" ON "credit_wallet"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_transaction_idempotencyKey_key" ON "credit_transaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "credit_transaction_workspaceId_occurredAt_idx" ON "credit_transaction"("workspaceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "credit_transaction_walletId_type_idx" ON "credit_transaction"("walletId", "type");

-- CreateIndex
CREATE INDEX "email_message_workspaceId_createdAt_idx" ON "email_message"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "email_message_toEmail_createdAt_idx" ON "email_message"("toEmail", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "email_message_status_idx" ON "email_message"("status");

-- CreateIndex
CREATE INDEX "workspace_planKey_idx" ON "workspace"("planKey");

-- AddForeignKey
ALTER TABLE "customer_session" ADD CONSTRAINT "customer_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invitedByPlatformUserId_fkey" FOREIGN KEY ("invitedByPlatformUserId") REFERENCES "platform_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_override" ADD CONSTRAINT "workspace_override_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_override" ADD CONSTRAINT "workspace_override_grantedByPlatformUserId_fkey" FOREIGN KEY ("grantedByPlatformUserId") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_wallet" ADD CONSTRAINT "credit_wallet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transaction" ADD CONSTRAINT "credit_transaction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transaction" ADD CONSTRAINT "credit_transaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "credit_wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_message" ADD CONSTRAINT "email_message_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- 2. Row-level security
--
-- Same two-policy shape as Phase 1: a tenant policy naming brandspace_app and
-- a platform policy naming brandspace_platform. A NULL workspace context
-- matches nothing, so the default is fail-closed.
-- ---------------------------------------------------------------------------

ALTER TABLE "customer_session"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_session"     FORCE  ROW LEVEL SECURITY;
ALTER TABLE "password_reset_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_token" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "invitation"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitation"           FORCE  ROW LEVEL SECURITY;
ALTER TABLE "workspace_override"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_override"   FORCE  ROW LEVEL SECURITY;
ALTER TABLE "credit_wallet"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_wallet"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "credit_transaction"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_transaction"   FORCE  ROW LEVEL SECURITY;
ALTER TABLE "email_message"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_message"        FORCE  ROW LEVEL SECURITY;

-- Tenant policies -----------------------------------------------------------

CREATE POLICY tenant_isolation ON "invitation"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "workspace_override"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "credit_wallet"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY tenant_isolation ON "credit_transaction"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- workspaceId IS NULL denotes a message that precedes any workspace (a password
-- reset). `NULL = <uuid>` is never true, so those rows stay invisible to every
-- tenant with no special case — the same construction as `audit_event`.
CREATE POLICY tenant_isolation ON "email_message"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

-- Sessions and reset tokens are reachable ONLY from the authentication path,
-- which runs with NO workspace context (withoutTenantContext). Inside a
-- workspace the table is empty for the tenant role, so a member of workspace A
-- cannot read session rows at all — theirs or anyone else's.
CREATE POLICY tenant_isolation ON "customer_session"
  TO brandspace_app
  USING      (app.current_workspace_id() IS NULL)
  WITH CHECK (app.current_workspace_id() IS NULL);

CREATE POLICY tenant_isolation ON "password_reset_token"
  TO brandspace_app
  USING      (app.current_workspace_id() IS NULL)
  WITH CHECK (app.current_workspace_id() IS NULL);

-- Platform policies ---------------------------------------------------------

CREATE POLICY platform_access ON "customer_session"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "password_reset_token"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "invitation"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "workspace_override"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "credit_wallet"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "credit_transaction"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON "email_message"
  TO brandspace_platform USING (true) WITH CHECK (true);

-- Privileges. The blanket GRANT from the Phase 1 RLS migration used
-- ALL TABLES, which only covers tables that existed then, so the new tables are
-- granted explicitly.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "customer_session", "password_reset_token", "invitation", "workspace_override",
  "credit_wallet", "credit_transaction", "email_message"
  TO brandspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "customer_session", "password_reset_token", "invitation", "workspace_override",
  "credit_wallet", "credit_transaction", "email_message"
  TO brandspace_platform;

-- The ledger is append-only for BOTH roles, exactly like audit_event. A trigger
-- below is the second stop, so removing this REVOKE alone does not open it.
REVOKE UPDATE, DELETE ON "credit_transaction" FROM brandspace_app;
REVOKE UPDATE, DELETE ON "credit_transaction" FROM brandspace_platform;

-- ---------------------------------------------------------------------------
-- 3. Constraints that encode business rules — docs/DATABASE.md §12
-- ---------------------------------------------------------------------------

-- A credit balance can never go negative. This is the backstop behind the row
-- lock taken by the service: even a bug that computed a wrong balance is
-- refused by the database.
ALTER TABLE "credit_wallet"
  ADD CONSTRAINT "credit_wallet_balance_non_negative"
  CHECK ("balanceMilliCredits" >= 0);
ALTER TABLE "credit_wallet"
  ADD CONSTRAINT "credit_wallet_reserved_non_negative"
  CHECK ("reservedMilliCredits" >= 0);
ALTER TABLE "credit_transaction"
  ADD CONSTRAINT "credit_transaction_balance_after_non_negative"
  CHECK ("balanceAfterMilliCredits" >= 0);

-- At most ONE pending invitation per (workspace, email). A partial unique index
-- makes a duplicate invite impossible rather than merely unlikely, and makes
-- concurrent invites for the same address collide at the database.
CREATE UNIQUE INDEX "invitation_one_pending_per_email"
  ON "invitation" ("workspaceId", "email")
  WHERE "status" = 'PENDING';

-- An invitation has exactly one inviter: a workspace member OR a platform
-- actor, never both and never neither. Attribution must be unambiguous.
ALTER TABLE "invitation"
  ADD CONSTRAINT "invitation_exactly_one_inviter"
  CHECK (
    ("invitedByUserId" IS NOT NULL AND "invitedByPlatformUserId" IS NULL)
    OR ("invitedByUserId" IS NULL AND "invitedByPlatformUserId" IS NOT NULL)
  );

-- The stored email is always lower-cased, so a case variant cannot accept
-- someone else's invitation and cannot create a second pending row that evades
-- the partial unique index above.
ALTER TABLE "invitation"
  ADD CONSTRAINT "invitation_email_is_lowercase"
  CHECK ("email" = lower("email"));

-- At most ONE active override per (workspace, feature). Without this, two
-- overrides could both claim precedence and the winner would depend on row
-- order.
CREATE UNIQUE INDEX "workspace_override_one_active_per_feature"
  ON "workspace_override" ("workspaceId", "featureKey")
  WHERE "status" = 'ACTIVE';

-- A suspended, archived or cancelled workspace must say why. An unexplained
-- lifecycle change is the thing support cannot answer.
ALTER TABLE "workspace"
  ADD CONSTRAINT "workspace_lifecycle_change_has_reason"
  CHECK (
    "status" NOT IN ('SUSPENDED', 'ARCHIVED', 'CANCELLED')
    OR "statusReason" IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- 4. Immutability triggers
-- ---------------------------------------------------------------------------

-- The ledger is the record of truth for every balance. A row, once written, is
-- never edited or removed: a correction is a compensating row. The REVOKE above
-- already stops the application roles; this stops the table owner too, so a
-- migration that forgot the REVOKE still cannot rewrite history.
CREATE OR REPLACE FUNCTION app.reject_credit_transaction_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'credit_transaction is append-only: a correction is a compensating row, not an edit';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_transaction_is_append_only
  BEFORE UPDATE OR DELETE ON "credit_transaction"
  FOR EACH ROW EXECUTE FUNCTION app.reject_credit_transaction_mutation();

-- A consumed or revoked invitation is terminal. Re-opening one by flipping the
-- status back to PENDING would resurrect a token the owner believed was spent.
CREATE OR REPLACE FUNCTION app.reject_invitation_resurrection()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" IN ('ACCEPTED', 'REVOKED', 'SUPERSEDED')
     AND NEW."status" = 'PENDING' THEN
    RAISE EXCEPTION
      'invitation % is terminal (%): issue a new invitation instead of reviving this one',
      OLD."id", OLD."status";
  END IF;
  IF OLD."tokenHash" IS DISTINCT FROM NEW."tokenHash" THEN
    RAISE EXCEPTION
      'invitation token is immutable: a resend creates a new invitation row';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invitation_status_is_terminal
  BEFORE UPDATE ON "invitation"
  FOR EACH ROW EXECUTE FUNCTION app.reject_invitation_resurrection();
