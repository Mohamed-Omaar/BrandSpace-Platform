-- CreateEnum
CREATE TYPE "ConfigurationStatus" AS ENUM ('DRAFT', 'VALIDATED', 'ACTIVE', 'SUPERSEDED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "DeploymentEnvironment" AS ENUM ('DEVELOPMENT', 'STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "SecretStatus" AS ENUM ('PENDING', 'ACTIVE', 'ROTATING', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SecretVersionStatus" AS ENUM ('PENDING', 'ACTIVE', 'RETIRED', 'REVOKED');

-- AlterTable
ALTER TABLE "platform_user" ADD COLUMN     "mfaEnrolledAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "configuration_version" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "payloadChecksum" TEXT NOT NULL,
    "status" "ConfigurationStatus" NOT NULL DEFAULT 'DRAFT',
    "previousVersionId" UUID,
    "rollbackOfVersionId" UUID,
    "validationReport" JSONB,
    "impactPreview" JSONB,
    "createdByPlatformUserId" UUID NOT NULL,
    "activatedByPlatformUserId" UUID,
    "changeReason" TEXT NOT NULL,
    "lockVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "activatedAt" TIMESTAMPTZ(6),
    "deactivatedAt" TIMESTAMPTZ(6),

    CONSTRAINT "configuration_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_record" (
    "id" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "SecretStatus" NOT NULL DEFAULT 'PENDING',
    "createdByPlatformUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "lastRotatedAt" TIMESTAMPTZ(6),
    "lastUsedAt" TIMESTAMPTZ(6),
    "disabledAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6),

    CONSTRAINT "secret_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secret_version" (
    "id" UUID NOT NULL,
    "secretRecordId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "wrappedDataKey" TEXT NOT NULL,
    "keyProvider" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM',
    "encryptionContext" TEXT NOT NULL,
    "maskedHint" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "SecretVersionStatus" NOT NULL DEFAULT 'PENDING',
    "createdByPlatformUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMPTZ(6),
    "retiredAt" TIMESTAMPTZ(6),

    CONSTRAINT "secret_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_session" (
    "id" UUID NOT NULL,
    "platformUserId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "mfaVerifiedAt" TIMESTAMPTZ(6),
    "stepUpVerifiedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "absoluteExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "platform_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_mfa_recovery_code" (
    "id" UUID NOT NULL,
    "platformUserId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_mfa_recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "configuration_version_domain_environment_status_idx" ON "configuration_version"("domain", "environment", "status");

-- CreateIndex
CREATE INDEX "configuration_version_activatedAt_idx" ON "configuration_version"("activatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "configuration_version_domain_environment_versionNumber_key" ON "configuration_version"("domain", "environment", "versionNumber");

-- CreateIndex
CREATE INDEX "secret_record_environment_status_idx" ON "secret_record"("environment", "status");

-- CreateIndex
CREATE INDEX "secret_record_category_idx" ON "secret_record"("category");

-- CreateIndex
CREATE UNIQUE INDEX "secret_record_ref_environment_key" ON "secret_record"("ref", "environment");

-- CreateIndex
CREATE INDEX "secret_version_secretRecordId_status_idx" ON "secret_version"("secretRecordId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "secret_version_secretRecordId_version_key" ON "secret_version"("secretRecordId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "platform_session_tokenHash_key" ON "platform_session"("tokenHash");

-- CreateIndex
CREATE INDEX "platform_session_platformUserId_revokedAt_idx" ON "platform_session"("platformUserId", "revokedAt");

-- CreateIndex
CREATE INDEX "platform_session_expiresAt_idx" ON "platform_session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "platform_mfa_recovery_code_codeHash_key" ON "platform_mfa_recovery_code"("codeHash");

-- CreateIndex
CREATE INDEX "platform_mfa_recovery_code_platformUserId_usedAt_idx" ON "platform_mfa_recovery_code"("platformUserId", "usedAt");

-- AddForeignKey
ALTER TABLE "configuration_version" ADD CONSTRAINT "configuration_version_createdByPlatformUserId_fkey" FOREIGN KEY ("createdByPlatformUserId") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_version" ADD CONSTRAINT "configuration_version_activatedByPlatformUserId_fkey" FOREIGN KEY ("activatedByPlatformUserId") REFERENCES "platform_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_record" ADD CONSTRAINT "secret_record_createdByPlatformUserId_fkey" FOREIGN KEY ("createdByPlatformUserId") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secret_version" ADD CONSTRAINT "secret_version_secretRecordId_fkey" FOREIGN KEY ("secretRecordId") REFERENCES "secret_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_session" ADD CONSTRAINT "platform_session_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_mfa_recovery_code" ADD CONSTRAINT "platform_mfa_recovery_code_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- PLATFORM-ONLY PROTECTION (Phase 2A)
--
-- These tables hold platform configuration, encrypted secret material and
-- Platform Admin sessions. They are not tenant-owned and the tenant application
-- role has no business reading them at all.
--
-- TWO independent controls, so neither alone is load-bearing:
--   1. GRANTs: every privilege is revoked from brandspace_app, so it cannot
--      even attempt a read.
--   2. RLS: enabled and FORCED with a policy naming brandspace_platform only,
--      so a future GRANT added by mistake still yields zero rows.
-- ===========================================================================

ALTER TABLE "configuration_version"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "configuration_version"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "secret_record"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "secret_record"              FORCE  ROW LEVEL SECURITY;
ALTER TABLE "secret_version"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "secret_version"             FORCE  ROW LEVEL SECURITY;
ALTER TABLE "platform_session"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_session"           FORCE  ROW LEVEL SECURITY;
ALTER TABLE "platform_mfa_recovery_code" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_mfa_recovery_code" FORCE  ROW LEVEL SECURITY;

CREATE POLICY platform_only ON "configuration_version"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_only ON "secret_record"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_only ON "secret_version"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_only ON "platform_session"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_only ON "platform_mfa_recovery_code"
  TO brandspace_platform USING (true) WITH CHECK (true);

-- The tenant role gets nothing on these tables, and never will by default.
REVOKE ALL ON "configuration_version"      FROM brandspace_app;
REVOKE ALL ON "secret_record"              FROM brandspace_app;
REVOKE ALL ON "secret_version"             FROM brandspace_app;
REVOKE ALL ON "platform_session"           FROM brandspace_app;
REVOKE ALL ON "platform_mfa_recovery_code" FROM brandspace_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON "configuration_version"      TO brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "secret_record"              TO brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "secret_version"             TO brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_session"           TO brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_mfa_recovery_code" TO brandspace_platform;

-- ---------------------------------------------------------------------------
-- At most ONE active configuration version per (domain, environment).
-- A partial unique index makes a second activation impossible at the database,
-- not merely unlikely in application code.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX configuration_version_one_active_per_domain_env
  ON "configuration_version" ("domain", "environment")
  WHERE "status" = 'ACTIVE';

-- At most one ACTIVE version per secret. Rotation moves the old one to RETIRED
-- in the same transaction, so there is never a window with two active keys.
CREATE UNIQUE INDEX secret_version_one_active_per_secret
  ON "secret_version" ("secretRecordId")
  WHERE "status" = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Secret material is append-only in the sense that matters: ciphertext, IV,
-- auth tag and wrapped key may never be mutated after creation. Rotation
-- creates a NEW version; it never edits an existing one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.reject_secret_material_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."ciphertext" IS DISTINCT FROM OLD."ciphertext"
     OR NEW."iv" IS DISTINCT FROM OLD."iv"
     OR NEW."authTag" IS DISTINCT FROM OLD."authTag"
     OR NEW."wrappedDataKey" IS DISTINCT FROM OLD."wrappedDataKey"
     OR NEW."encryptionContext" IS DISTINCT FROM OLD."encryptionContext" THEN
    RAISE EXCEPTION
      'secret_version material is immutable; rotate by creating a new version'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER secret_version_material_is_immutable
  BEFORE UPDATE ON "secret_version"
  FOR EACH ROW EXECUTE FUNCTION app.reject_secret_material_mutation();

-- ---------------------------------------------------------------------------
-- An ACTIVE configuration version is immutable: it is the record of what was
-- deployed. Edits happen on DRAFT rows; activation supersedes, never rewrites.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.reject_active_configuration_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'ACTIVE'
     AND (NEW."payload"::text IS DISTINCT FROM OLD."payload"::text
          OR NEW."payloadChecksum" IS DISTINCT FROM OLD."payloadChecksum") THEN
    RAISE EXCEPTION
      'an ACTIVE configuration version is immutable; create a new draft instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER configuration_version_active_is_immutable
  BEFORE UPDATE ON "configuration_version"
  FOR EACH ROW EXECUTE FUNCTION app.reject_active_configuration_edit();
