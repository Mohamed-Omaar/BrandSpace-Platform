import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { asPlatform } from '@brandspace/database';
import { ALL_PERMISSIONS, ROLE_DEFINITIONS } from '@brandspace/shared';

/**
 * Two workspaces with deliberately overlapping data shapes, so a test that passes
 * by accident (because one side has no comparable row) is not possible.
 */

export interface TenantFixture {
  readonly workspaceId: string;
  readonly slug: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly membershipId: string;
  readonly auditEventId: string;
  readonly customRoleId: string;
  readonly supportSessionId: string;
}

export interface IsolationFixtures {
  readonly a: TenantFixture;
  readonly b: TenantFixture;
  readonly platformUserId: string;
  /** An audit event with workspaceId = null: a platform-only event. */
  readonly platformAuditEventId: string;
}

const FIXTURE_REQUEST_ID = 'test-fixture-request';

const SEED_ACTOR = {
  platformUserId: '00000000-0000-4000-8000-0000000000ff',
  roleKey: 'platform_owner',
  mfaVerified: true,
} as const;

/** A client on the APPLICATION role — the role whose access the tests constrain. */
export function appRoleClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * A client on the PLATFORM role. Fixtures provision data across tenants, which
 * is a platform operation, so they use the platform identity exactly as
 * production platform code does. Nothing gets a private door.
 */
export function platformRoleClient(): PrismaClient {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required for fixtures.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * Ensure the `platform_owner` role exists and return its id.
 *
 * Exported because a suite must never ASSUME the role is there. CI runs
 * migrations only — no seed — so a test that reads the role and asserts it is
 * non-null passes on a developer machine that has been seeded and fails on a
 * fresh database. Every suite bootstraps what it needs.
 */
export async function ensurePlatformRole(prisma: PrismaClient): Promise<string> {
  return asPlatform(
    SEED_ACTOR,
    {
      action: 'test.fixture.role',
      reason: 'Isolation test fixture bootstrap',
      requestId: FIXTURE_REQUEST_ID,
    },
    async (db) => {
      const existing = await db.role.findFirst({
        where: { key: 'platform_owner', workspaceId: null },
      });
      if (existing) return existing.id;
      const created = await db.role.create({
        data: {
          key: 'platform_owner',
          workspaceId: null,
          realm: 'PLATFORM',
          nameEn: 'Platform Owner',
          nameAr: 'مالك المنصة',
          isSystem: true,
        },
      });
      return created.id;
    },
    { prisma, bootstrap: true },
  );
}

/**
 * Bootstrap the full permission catalogue and every PLATFORM role, exactly as
 * the repository seed does.
 *
 * The RBAC suite reads each role's permissions back OUT of the database rather
 * than trusting the constant, so it proves the whole chain: definition ->
 * seeded rows -> service enforcement. Mirrors `packages/database/prisma/seed.ts`
 * deliberately; if the two ever disagree, `tests/unit/rbac-matrix.test.ts`
 * fails on the definitions and this suite fails on behaviour.
 */
export async function ensurePlatformRbac(prisma: PrismaClient): Promise<void> {
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

  await asPlatform(
    SEED_ACTOR,
    {
      action: 'test.fixture.rbac',
      reason: 'Isolation test fixture bootstrap',
      requestId: FIXTURE_REQUEST_ID,
    },
    async (db) => {
      for (const definition of ROLE_DEFINITIONS.filter((d) => d.realm === 'platform')) {
        const existing = await db.role.findFirst({
          where: { key: definition.key, workspaceId: null },
        });
        const role =
          existing ??
          (await db.role.create({
            data: {
              key: definition.key,
              workspaceId: null,
              realm: 'PLATFORM',
              nameEn: definition.nameEn,
              nameAr: definition.nameAr,
              isSystem: true,
            },
          }));

        // Replace, never merge: a permission removed from a role must actually
        // disappear, or a demotion would be cosmetic.
        await db.rolePermission.deleteMany({ where: { roleId: role.id } });
        for (const key of definition.permissionKeys) {
          const permission = await db.permission.findUniqueOrThrow({ where: { key } });
          await db.rolePermission.create({
            data: { roleId: role.id, permissionId: permission.id },
          });
        }
      }
    },
    { prisma, bootstrap: true },
  );
}

async function ensureWorkspaceRole(prisma: PrismaClient): Promise<string> {
  return asPlatform(
    SEED_ACTOR,
    {
      action: 'test.fixture.role',
      reason: 'Isolation test fixture bootstrap',
      requestId: FIXTURE_REQUEST_ID,
    },
    async (db) => {
      const existing = await db.role.findFirst({
        where: { key: 'workspace_owner', workspaceId: null },
      });
      if (existing) return existing.id;
      const created = await db.role.create({
        data: {
          key: 'workspace_owner',
          workspaceId: null,
          realm: 'WORKSPACE',
          nameEn: 'Workspace Owner',
          nameAr: 'مالك مساحة العمل',
          isSystem: true,
        },
      });
      return created.id;
    },
    { prisma, bootstrap: true },
  );
}

async function createTenant(
  prisma: PrismaClient,
  slug: string,
  email: string,
  workspaceRoleId: string,
  platformUserId: string,
): Promise<TenantFixture> {
  const user = await prisma.user.create({
    data: { email, name: `User ${slug}`, status: 'ACTIVE', emailVerifiedAt: new Date() },
  });

  return asPlatform(
    SEED_ACTOR,
    {
      action: 'test.fixture.workspace',
      reason: `Isolation test fixture: provision ${slug}`,
      requestId: FIXTURE_REQUEST_ID,
    },
    async (db) => {
      const id = crypto.randomUUID();
      const workspace = await db.workspace.create({
        data: {
          id,
          workspaceId: id,
          slug,
          name: `Workspace ${slug}`,
          ownerUserId: user.id,
          status: 'ACTIVE',
        },
      });
      const membership = await db.membership.create({
        data: {
          workspaceId: id,
          userId: user.id,
          roleId: workspaceRoleId,
          status: 'ACTIVE',
          acceptedAt: new Date(),
          brandScope: [],
        },
      });
      // A workspace-private custom role, to prove custom roles do not leak.
      const customRole = await db.role.create({
        data: {
          workspaceId: id,
          key: `custom_${slug}`,
          realm: 'WORKSPACE',
          nameEn: `Custom ${slug}`,
          nameAr: `مخصص ${slug}`,
          isSystem: false,
        },
      });
      const audit = await db.auditEvent.create({
        data: {
          workspaceId: id,
          actorType: 'SYSTEM',
          action: 'workspace.created',
          resourceType: 'workspace',
          resourceId: id,
          reason: `fixture ${slug}`,
        },
      });
      const support = await db.supportModeSession.create({
        data: {
          workspaceId: id,
          platformUserId,
          reason: `fixture support session ${slug}`,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });

      return {
        workspaceId: workspace.id,
        slug,
        userId: user.id,
        userEmail: email,
        membershipId: membership.id,
        auditEventId: audit.id,
        customRoleId: customRole.id,
        supportSessionId: support.id,
      };
    },
    { prisma, bootstrap: true },
  );
}

/** Build a fresh pair of tenants with unique identifiers for one test run. */
export async function createIsolationFixtures(
  _appPrisma: PrismaClient,
): Promise<IsolationFixtures> {
  // Fixtures are provisioned on the PLATFORM pool. The app pool cannot create
  // data for two different tenants — which is the property under test.
  const prisma = platformRoleClient();
  const run = crypto.randomUUID().slice(0, 8);
  const platformRoleId = await ensurePlatformRole(prisma);
  const workspaceRoleId = await ensureWorkspaceRole(prisma);

  const platformUser = await prisma.platformUser.create({
    data: {
      email: `platform-${run}@brandspace.local`,
      name: 'Fixture Platform User',
      status: 'ACTIVE',
      roleId: platformRoleId,
    },
  });

  const a = await createTenant(
    prisma,
    `tenant-a-${run}`,
    `a-${run}@example.local`,
    workspaceRoleId,
    platformUser.id,
  );
  const b = await createTenant(
    prisma,
    `tenant-b-${run}`,
    `b-${run}@example.local`,
    workspaceRoleId,
    platformUser.id,
  );

  // A platform-only audit event (workspaceId = null).
  const platformAuditEventId = await asPlatform(
    SEED_ACTOR,
    {
      action: 'test.fixture.audit',
      reason: 'Isolation test fixture: platform-only event',
      requestId: FIXTURE_REQUEST_ID,
    },
    async (db) => {
      const created = await db.auditEvent.create({
        data: {
          workspaceId: null,
          actorType: 'PLATFORM_USER',
          actorId: platformUser.id,
          action: 'platform.internal.event',
          reason: 'platform-only fixture event',
        },
      });
      return created.id;
    },
    { prisma, bootstrap: true },
  );

  await prisma.$disconnect();
  return { a, b, platformUserId: platformUser.id, platformAuditEventId };
}
