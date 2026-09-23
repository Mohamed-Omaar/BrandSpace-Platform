/**
 * One-off staging Platform Owner bootstrap.
 *
 * STAGING ONLY. This script refuses every other APP_ENV and is intended for
 * controlled staging setup. It never reads or writes production resources.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ALL_PERMISSIONS, ROLE_DEFINITIONS } from '@brandspace/shared';
import { buildSecretRef, SecretService } from '@brandspace/secrets';
import { hashPassword, PlatformAuthService } from '@brandspace/auth';
import { assertPlatformRole } from '../src/platform';

const ENVIRONMENT = 'STAGING' as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function client(): PrismaClient {
  const connectionString = required('DATABASE_PLATFORM_URL');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function syncCatalogue(
  prisma: PrismaClient,
  actorId: string,
): Promise<Map<string, string>> {
  for (const permission of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: {
        resource: permission.resource,
        action: permission.action,
        minScope: permission.minScope,
        description: permission.description,
      },
      create: {
        key: permission.key,
        resource: permission.resource,
        action: permission.action,
        minScope: permission.minScope,
        description: permission.description,
      },
    });
  }

  const roleIds = new Map<string, string>();
  for (const definition of ROLE_DEFINITIONS) {
    const existing = await prisma.role.findFirst({
      where: { key: definition.key, workspaceId: null },
    });
    const role = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: {
            nameEn: definition.nameEn,
            nameAr: definition.nameAr,
            realm: definition.realm === 'platform' ? 'PLATFORM' : 'WORKSPACE',
            isSystem: true,
          },
        })
      : await prisma.role.create({
          data: {
            key: definition.key,
            workspaceId: null,
            realm: definition.realm === 'platform' ? 'PLATFORM' : 'WORKSPACE',
            nameEn: definition.nameEn,
            nameAr: definition.nameAr,
            isSystem: true,
          },
        });

    roleIds.set(definition.key, role.id);
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    for (const permissionKey of definition.permissionKeys) {
      const permission = await prisma.permission.findUnique({ where: { key: permissionKey } });
      if (!permission) throw new Error(`Unknown permission: ${permissionKey}`);
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
  }

  return roleIds;
}

async function main(): Promise<void> {
  if (process.env['APP_ENV'] !== 'staging') {
    throw new Error('Refusing to run: bootstrap-staging-owner requires APP_ENV=staging.');
  }

  const email = required('BOOTSTRAP_STAGING_OWNER_EMAIL').toLowerCase();
  const password = required('BOOTSTRAP_STAGING_OWNER_PASSWORD');
  const totpSecret = required('BOOTSTRAP_STAGING_OWNER_TOTP_SECRET');
  const recoveryCodes = required('BOOTSTRAP_STAGING_OWNER_RECOVERY_CODES')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (password.length < 12) throw new Error('Staging owner password is too short.');
  if (recoveryCodes.length < 2) throw new Error('At least two recovery codes are required.');

  const prisma = client();
  try {
    await assertPlatformRole(prisma);

    const existing = await prisma.platformUser.findUnique({ where: { email } });
    const ownerId = existing?.id ?? crypto.randomUUID();
    const roleIds = await syncCatalogue(prisma, ownerId);
    const ownerRoleId = roleIds.get('platform_owner');
    if (!ownerRoleId) throw new Error('platform_owner role was not created.');

    const owner = await prisma.platformUser.upsert({
      where: { email },
      update: {
        name: 'Staging Platform Owner',
        status: 'ACTIVE',
        roleId: ownerRoleId,
      },
      create: {
        id: ownerId,
        email,
        name: 'Staging Platform Owner',
        status: 'ACTIVE',
        mfaEnabled: false,
        passwordHash: null,
        roleId: ownerRoleId,
      },
    });

    const permissionKeys = (
      await prisma.rolePermission.findMany({
        where: { roleId: ownerRoleId },
        include: { permission: true },
      })
    ).map((row) => row.permission.key);

    const actor = {
      platformUserId: owner.id,
      roleKey: 'platform_owner',
      mfaVerified: true,
      permissionKeys,
    };

    const ref = buildSecretRef({
      category: 'mfa_totp',
      provider: 'platform',
      environment: 'staging',
      name: email,
    });

    const secrets = new SecretService({ prisma, env: process.env });
    const existingSecret = await prisma.secretRecord.findUnique({
      where: { ref_environment: { ref, environment: ENVIRONMENT } },
      select: { id: true },
    });

    if (existingSecret) {
      await secrets.rotateSecret(
        actor,
        existingSecret.id,
        totpSecret,
        'Staging owner bootstrap credential rotation',
      );
    } else {
      await secrets.createSecret(actor, {
        ref,
        name: `TOTP seed for ${email}`,
        category: 'mfa_totp',
        environment: ENVIRONMENT,
        value: totpSecret,
      });
    }

    const auth = new PlatformAuthService({ prisma });
    await auth.storeRecoveryCodes(owner.id, recoveryCodes);
    await prisma.platformUser.update({
      where: { id: owner.id },
      data: {
        passwordHash: await hashPassword(password),
        mfaEnabled: true,
        mfaSecretRef: ref,
        mfaEnrolledAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    await auth.revokeAllSessions(owner.id, 'Staging owner bootstrap refreshed credentials');

    await prisma.auditEvent.create({
      data: {
        workspaceId: null,
        actorType: 'PLATFORM_USER',
        actorId: owner.id,
        action: 'platform.bootstrap.staging.owner',
        resourceType: 'platform_user',
        resourceId: owner.id,
        severity: 'NOTICE',
        outcome: 'SUCCESS',
        reason: 'Staging Platform Owner bootstrap completed',
      },
    });

    console.log('STAGING_OWNER_BOOTSTRAP_OK');
    console.log(`owner=${email}`);
    console.log(`recovery_codes=${recoveryCodes.length}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Staging owner bootstrap failed.');
  process.exitCode = 1;
});
