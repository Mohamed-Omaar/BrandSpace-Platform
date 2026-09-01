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
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ALL_PERMISSIONS,
  ROLE_DEFINITIONS,
  assertRealmsAreDisjoint,
  assertRolePermissionsAreValid,
} from '@brandspace/shared';
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

function client(): PrismaClient {
  const connectionString = process.env['DATABASE_MIGRATION_URL'] ?? process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function main(): Promise<void> {
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
      { action: 'platform.seed.roles', reason: 'Development seed: create system roles' },
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

    console.log('\n✔ seed complete');
    console.log('  Platform Owner : owner@brandspace.local');
    console.log('  Workspace A    : acme-agency  / amal@acme.local');
    console.log('  Workspace B    : north-star   / noor@northstar.local');
    console.log('  No passwords are seeded; auth flows arrive in Phase 2.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
