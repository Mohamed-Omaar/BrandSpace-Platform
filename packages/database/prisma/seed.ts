/**
 * Development seed.
 *
 * Creates exactly what Phase 1 requires:
 *   - one Platform Owner (platform realm, MFA required by D-27)
 *   - system roles and the permission catalogue
 *   - TWO separate customer workspaces, each with its own user
 *
 * The two workspaces exist so tenant isolation can be demonstrated by hand as
 * well as by the automated suite.
 *
 * NOTE: workspace creation goes through asPlatform(), because `FORCE ROW LEVEL
 * SECURITY` subjects even the table owner to policy. The seed therefore exercises
 * the same audited path production code uses — it does not get a private door.
 */
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ALL_PERMISSIONS,
  ROLE_DEFINITIONS,
  assertRealmsAreDisjoint,
  assertRolePermissionsAreValid,
} from '@brandspace/shared';
import { loadRepoEnv, requireDatabaseUrl } from '../src/env-file';
import { resolveSeedPassword } from './seed-password';
import { asPlatform } from '../src/platform';
import { withWorkspace } from '../src/tenant-client';

const SEED_ACTOR = {
  platformUserId: '00000000-0000-4000-8000-000000000001',
  roleKey: 'platform_owner',
  mfaVerified: true,
} as const;

/**
 * Development-only credential placeholder. This is NOT a password hash of a real
 * password: local sign-in flows arrive in Phase 2 with Argon2id hashing. No real
 * credential is ever committed (CLAUDE.md §2.6).
 */
const DEV_PASSWORD_PLACEHOLDER = null;

/**
 * Whether the enrolment secret may be printed.
 *
 * The TOTP seed has to reach a human once — that is what enrolment IS — but a
 * seed run whose output is captured (CI, a log file, a pipe) would leave that
 * credential in a retained, searchable place. So it is printed only when a
 * person is demonstrably watching, or when the operator explicitly overrides.
 */
function mayPrintEnrolment(): boolean {
  if (process.env['SEED_PRINT_MFA_ENROLMENT'] === '1') return true;
  if (process.env['CI']) return false;
  return process.stdout.isTTY === true;
}

function client(): PrismaClient {
  // The seed performs PLATFORM operations — it provisions workspaces across
  // tenants — so it connects as the platform role, exactly like production
  // platform code. It gets no private door: `FORCE ROW LEVEL SECURITY` means
  // even the schema owner is subject to policy, and only brandspace_platform is
  // named by a cross-tenant policy.
  //
  // Loads the env file rather than relying on variables leaking from the
  // developer's shell, so `pnpm db:seed` works on a clean checkout. Fails closed
  // with a redacted error when no URL is configured.
  loadRepoEnv(path.resolve(import.meta.dirname, '..', '..', '..'));
  const connectionString = requireDatabaseUrl(
    ['DATABASE_PLATFORM_URL'],
    'the seed provisions workspaces across tenants and needs the platform role',
  );
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function main(): Promise<void> {
  // One correlation id for the whole seed run.
  const seedRequestId = `seed-${crypto.randomUUID()}`;

  // Fail fast if the role/permission model is internally inconsistent.
  assertRealmsAreDisjoint();
  assertRolePermissionsAreValid();

  const prisma = client();

  try {
    console.log('› seeding permission catalogue …');
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
    console.log(`  ${ALL_PERMISSIONS.length} permissions`);

    console.log('› seeding system roles …');
    // System roles have workspaceId = null and are readable by every workspace.
    // Writing them is a platform operation, so it runs under asPlatform().
    const roleIdsByKey = new Map<string, string>();
    await asPlatform(
      SEED_ACTOR,
      {
        action: 'platform.seed.roles',
        reason: 'Development seed: create system roles',
        requestId: seedRequestId,
      },
      async (db) => {
        for (const definition of ROLE_DEFINITIONS) {
          const existing = await db.role.findFirst({
            where: { key: definition.key, workspaceId: null },
          });
          const role = existing
            ? await db.role.update({
                where: { id: existing.id },
                data: {
                  nameEn: definition.nameEn,
                  nameAr: definition.nameAr,
                  realm: definition.realm === 'platform' ? 'PLATFORM' : 'WORKSPACE',
                  isSystem: true,
                },
              })
            : await db.role.create({
                data: {
                  key: definition.key,
                  workspaceId: null,
                  realm: definition.realm === 'platform' ? 'PLATFORM' : 'WORKSPACE',
                  nameEn: definition.nameEn,
                  nameAr: definition.nameAr,
                  isSystem: true,
                },
              });
          roleIdsByKey.set(definition.key, role.id);

          await db.rolePermission.deleteMany({ where: { roleId: role.id } });
          for (const permissionKey of definition.permissionKeys) {
            const permission = await db.permission.findUnique({ where: { key: permissionKey } });
            if (!permission) throw new Error(`Unknown permission: ${permissionKey}`);
            await db.rolePermission.create({
              data: { roleId: role.id, permissionId: permission.id },
            });
          }
        }
      },
      { bootstrap: true },
    );
    console.log(`  ${ROLE_DEFINITIONS.length} roles`);

    const platformOwnerRoleId = roleIdsByKey.get('platform_owner');
    if (!platformOwnerRoleId) throw new Error('platform_owner role was not created.');

    console.log('› seeding Platform Owner …');
    const platformOwner = await prisma.platformUser.upsert({
      where: { email: 'owner@brandspace.local' },
      update: { roleId: platformOwnerRoleId },
      create: {
        id: SEED_ACTOR.platformUserId,
        email: 'owner@brandspace.local',
        name: 'Platform Owner',
        status: 'ACTIVE',
        // D-27: 2FA is mandatory for platform roles. Enrolment happens at first
        // sign-in (Phase 2); the flag records that it is required, not satisfied.
        mfaEnabled: false,
        passwordHash: DEV_PASSWORD_PLACEHOLDER,
        roleId: platformOwnerRoleId,
      },
    });
    console.log(`  ${platformOwner.email}`);

    // --- Two isolated customer workspaces ---------------------------------
    const workspaceOwnerRoleId = roleIdsByKey.get('workspace_owner');
    const marketingManagerRoleId = roleIdsByKey.get('marketing_manager');
    if (!workspaceOwnerRoleId || !marketingManagerRoleId) {
      throw new Error('Workspace roles were not created.');
    }

    const tenants = [
      {
        slug: 'acme-agency',
        name: 'Acme Agency',
        type: 'AGENCY' as const,
        userEmail: 'amal@acme.local',
        userName: 'Amal (Acme)',
        locale: 'AR' as const,
      },
      {
        slug: 'north-star',
        name: 'North Star Co',
        type: 'COMPANY' as const,
        userEmail: 'noor@northstar.local',
        userName: 'Noor (North Star)',
        locale: 'EN' as const,
      },
    ];

    console.log('› seeding two isolated customer workspaces …');
    for (const tenant of tenants) {
      const user = await prisma.user.upsert({
        where: { email: tenant.userEmail },
        update: {},
        create: {
          email: tenant.userEmail,
          name: tenant.userName,
          status: 'ACTIVE',
          locale: tenant.locale,
          timezone: 'Asia/Riyadh',
          emailVerifiedAt: new Date(),
          passwordHash: DEV_PASSWORD_PLACEHOLDER,
        },
      });

      const workspaceId = await asPlatform(
        SEED_ACTOR,
        {
          action: 'platform.workspace.create',
          reason: `Development seed: provision workspace ${tenant.slug}`,
          requestId: seedRequestId,
          resourceType: 'workspace',
        },
        async (db) => {
          const existing = await db.workspace.findUnique({ where: { slug: tenant.slug } });
          if (existing) return existing.id;

          const id = crypto.randomUUID();
          const workspace = await db.workspace.create({
            data: {
              id,
              // Self-referential tenant key; a CHECK constraint enforces equality.
              workspaceId: id,
              slug: tenant.slug,
              name: tenant.name,
              type: tenant.type,
              status: 'TRIALING',
              country: 'SA',
              defaultLocale: tenant.locale,
              timezone: 'Asia/Riyadh',
              currency: 'SAR',
              ownerUserId: user.id,
              trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            },
          });
          await db.membership.create({
            data: {
              workspaceId: workspace.id,
              userId: user.id,
              roleId: workspaceOwnerRoleId,
              status: 'ACTIVE',
              acceptedAt: new Date(),
              brandScope: [],
            },
          });
          return workspace.id;
        },
        { bootstrap: true },
      );

      // Workspace-scoped audit event, written through the tenant path.
      await withWorkspace(
        workspaceId,
        async (db) => {
          await db.auditEvent.create({
            data: {
              workspaceId,
              actorType: 'SYSTEM',
              action: 'workspace.created',
              resourceType: 'workspace',
              resourceId: workspaceId,
              severity: 'NOTICE',
              outcome: 'SUCCESS',
              reason: 'Development seed',
            },
          });
        },
        { prisma },
      );

      console.log(`  ${tenant.slug} (${workspaceId}) — owner ${tenant.userEmail}`);
    }

    // --- Platform Owner MFA + password -------------------------------------
    // There is NO fallback password. A literal committed here would be a known
    // credential for every database this seed is ever pointed at, including one
    // it was pointed at by mistake. Absent variable -> the owner is created
    // without a password and simply cannot sign in. Present but weak or
    // placeholder -> a hard error, because that is somebody trying and failing.
    const ownerPassword = resolveSeedPassword();
    const { hashPassword } = await import('@brandspace/auth');
    const { generateTotpEnrolment, generateRecoveryCodes } = await import('@brandspace/auth');
    const { SecretService, buildSecretRef } = await import('@brandspace/secrets');

    const enrolment = generateTotpEnrolment(platformOwner.email);
    const ownerPermissionKeys =
      ROLE_DEFINITIONS.find((d) => d.key === 'platform_owner')?.permissionKeys ?? [];
    const secretService = new SecretService({ prisma });
    const mfaRef = buildSecretRef({
      category: 'mfa_totp',
      provider: 'platform',
      environment: 'development',
      name: platformOwner.email,
    });

    const existingMfa = await prisma.secretRecord.findUnique({
      where: { ref_environment: { ref: mfaRef, environment: 'DEVELOPMENT' } },
    });
    if (!existingMfa) {
      await secretService.createSecret(
        {
          platformUserId: platformOwner.id,
          roleKey: 'platform_owner',
          mfaVerified: true,
          // The seed acts as the Platform Owner, so it carries that role's
          // permissions rather than a bespoke bypass.
          permissionKeys: ownerPermissionKeys,
        },
        {
          ref: mfaRef,
          name: `TOTP seed for ${platformOwner.email}`,
          category: 'mfa_totp',
          environment: 'DEVELOPMENT',
          value: enrolment.secret,
        },
      );
      await prisma.platformUser.update({
        where: { id: platformOwner.id },
        data: {
          // Null when SEED_PLATFORM_PASSWORD is absent: the account exists, is
          // enrolled in MFA, and cannot be signed into until a real password is
          // set. `verifyPassword` treats a null hash as a failed login.
          passwordHash: ownerPassword === null ? null : await hashPassword(ownerPassword),
          mfaEnabled: true,
          mfaSecretRef: mfaRef,
          mfaEnrolledAt: new Date(),
        },
      });

      const recoveryCodes = generateRecoveryCodes();
      const { PlatformAuthService } = await import('@brandspace/auth');
      await new PlatformAuthService({ prisma }).storeRecoveryCodes(platformOwner.id, recoveryCodes);

      console.log('  MFA enrolled for the Platform Owner (development).');
      if (mayPrintEnrolment()) {
        console.log(
          '  TOTP secret and recovery codes are printed ONCE, here, and never stored in clear:',
        );
        console.log(`    otpauth URI : ${enrolment.otpauthUri}`);
        console.log(`    recovery    : ${recoveryCodes.join(' ')}`);
      } else {
        console.log('  Enrolment details WITHHELD: this is not an interactive terminal.');
        console.log('  Printing a TOTP seed into a CI log or a redirected file would put a');
        console.log('  credential somewhere it is retained and searchable (CLAUDE.md §2.3).');
        console.log('  Re-run the seed from a terminal, or set SEED_PRINT_MFA_ENROLMENT=1 if you');
        console.log('  are certain the output is not being captured.');
      }
    } else {
      console.log('  Platform Owner MFA already enrolled; leaving it untouched.');
    }

    console.log('\n✔ seed complete');
    console.log('  Platform Owner : owner@brandspace.local');
    console.log('  Workspace A    : acme-agency  / amal@acme.local');
    console.log('  Workspace B    : north-star   / noor@northstar.local');
    console.log(
      ownerPassword === null
        ? '  Platform Owner sign-in is DISABLED: SEED_PLATFORM_PASSWORD was not set, so no\n' +
            '  password was stored. Set it and re-run the seed to enable sign-in.'
        : '  Platform Owner password came from SEED_PLATFORM_PASSWORD (never printed).',
    );
    console.log('  Customer auth flows arrive in Phase 2B.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
