-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'DELETED');

-- CreateEnum
CREATE TYPE "WorkspaceType" AS ENUM ('INDIVIDUAL', 'STARTUP', 'COMPANY', 'CREATOR', 'AGENCY', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "RoleRealm" AS ENUM ('WORKSPACE', 'PLATFORM');

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('AR', 'EN');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'PLATFORM_USER', 'SYSTEM', 'AUTOMATION', 'COPILOT');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('INFO', 'NOTICE', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'DENIED', 'ERROR');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMPTZ(6),
    "passwordHash" TEXT,
    "name" TEXT,
    "locale" "Locale" NOT NULL DEFAULT 'EN',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecretRef" TEXT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMPTZ(6),
    "passwordHash" TEXT,
    "name" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecretRef" TEXT,
    "roleId" UUID NOT NULL,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "platform_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "type" "WorkspaceType" NOT NULL DEFAULT 'STARTUP',
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'TRIALING',
    "country" TEXT NOT NULL DEFAULT 'SA',
    "defaultLocale" "Locale" NOT NULL DEFAULT 'AR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    "currency" CHAR(3) NOT NULL DEFAULT 'SAR',
    "ownerUserId" UUID NOT NULL,
    "trialEndsAt" TIMESTAMPTZ(6),
    "suspendedAt" TIMESTAMPTZ(6),
    "suspendedReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "brandScope" UUID[],
    "status" "MembershipStatus" NOT NULL DEFAULT 'INVITED',
    "invitedByUserId" UUID,
    "invitationTokenHash" TEXT,
    "invitationExpiresAt" TIMESTAMPTZ(6),
    "acceptedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "key" TEXT NOT NULL,
    "realm" "RoleRealm" NOT NULL DEFAULT 'WORKSPACE',
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "minScope" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "actorEmailHash" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" UUID,
    "brandId" UUID,
    "severity" "AuditSeverity" NOT NULL DEFAULT 'INFO',
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'SUCCESS',
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "traceId" TEXT,
    "supportModeSessionId" UUID,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_mode_session" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "platformUserId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "ticketRef" TEXT,
    "writeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "grantedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "endedAt" TIMESTAMPTZ(6),

    CONSTRAINT "support_mode_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_status_idx" ON "user"("status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_email_key" ON "platform_user"("email");

-- CreateIndex
CREATE INDEX "platform_user_status_idx" ON "platform_user"("status");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_workspaceId_key" ON "workspace"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_slug_key" ON "workspace"("slug");

-- CreateIndex
CREATE INDEX "workspace_status_idx" ON "workspace"("status");

-- CreateIndex
CREATE INDEX "workspace_ownerUserId_idx" ON "workspace"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "membership_invitationTokenHash_key" ON "membership"("invitationTokenHash");

-- CreateIndex
CREATE INDEX "membership_workspaceId_status_idx" ON "membership"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "membership_userId_status_idx" ON "membership"("userId", "status");

-- CreateIndex
CREATE INDEX "membership_roleId_idx" ON "membership"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "membership_workspaceId_userId_key" ON "membership"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "role_realm_idx" ON "role"("realm");

-- CreateIndex
CREATE UNIQUE INDEX "role_workspaceId_key_key" ON "role"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "permission_key_key" ON "permission"("key");

-- CreateIndex
CREATE INDEX "permission_resource_idx" ON "permission"("resource");

-- CreateIndex
CREATE INDEX "role_permission_permissionId_idx" ON "role_permission"("permissionId");

-- CreateIndex
CREATE INDEX "audit_event_workspaceId_occurredAt_idx" ON "audit_event"("workspaceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "audit_event_actorId_occurredAt_idx" ON "audit_event"("actorId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "audit_event_resourceType_resourceId_occurredAt_idx" ON "audit_event"("resourceType", "resourceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "audit_event_action_occurredAt_idx" ON "audit_event"("action", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "support_mode_session_workspaceId_grantedAt_idx" ON "support_mode_session"("workspaceId", "grantedAt" DESC);

-- CreateIndex
CREATE INDEX "support_mode_session_platformUserId_grantedAt_idx" ON "support_mode_session"("platformUserId", "grantedAt" DESC);

-- CreateIndex
CREATE INDEX "support_mode_session_expiresAt_idx" ON "support_mode_session"("expiresAt");

-- AddForeignKey
ALTER TABLE "platform_user" ADD CONSTRAINT "platform_user_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_mode_session" ADD CONSTRAINT "support_mode_session_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_mode_session" ADD CONSTRAINT "support_mode_session_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
