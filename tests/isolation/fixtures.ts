import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { asPlatform } from '@brandspace/database';

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

/** A client on the OWNER role, used only to build fixtures. */
export function ownerRoleClient(): PrismaClient {
  const connectionString = process.env['DATABASE_MIGRATION_URL'];
  if (!connectionString) throw new Error('DATABASE_MIGRATION_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function ensurePlatformRole(prisma: PrismaClient): Promise<string> {
  return asPlatform(
    SEED_ACTOR,
    { action: 'test.fixture.role', reason: 'Isolation test fixture bootstrap' },
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

async function ensureWorkspaceRole(prisma: PrismaClient): Promise<string> {
  return asPlatform(
    SEED_ACTOR,
    { action: 'test.fixture.role', reason: 'Isolation test fixture bootstrap' },
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
export async function createIsolationFixtures(prisma: PrismaClient): Promise<IsolationFixtures> {
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
    { action: 'test.fixture.audit', reason: 'Isolation test fixture: platform-only event' },
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

  return { a, b, platformUserId: platformUser.id, platformAuditEventId };
}
