import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvitationService, MembershipService } from '@brandspace/auth';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 6 · P6-13 — BRAND ACCESS IS AUTHORIZATION, AND NOW IT CAN BE MANAGED.
 *
 * BrandScope decides which brands a member of a workspace can see. Until now
 * nothing could change it, and the invitation path stored whatever it was
 * handed — which, from the Team screen, was always "every brand", even when the
 * inviter could see one. Both grant paths now go through one rule
 * (`resolveGrantableBrandScope`), pinned here against real PostgreSQL:
 *
 *   1. requested brands must be live brands of THIS workspace — a foreign id is
 *      refused exactly like an invented one;
 *   2. a brand-restricted actor may grant only a non-empty subset of their own
 *      brands — never "all brands";
 *   3. the workspace owner is never restricted, and an admin cannot change the
 *      owner (the role ladder);
 *   4. every change is audited, before and after;
 *   5. a membership in another workspace is a 404, not a way in.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let memberships: MembershipService;
let invitations: InvitationService;
let analystRoleId: string;
let brandTwo: string;
let colleagueMembershipId: string;
let colleagueUserId: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const OWNER_PERMISSIONS = ['member.read', 'member.invite', 'member.assign_role'];

function owner(brandScope: readonly string[] = []) {
  return {
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: OWNER_PERMISSIONS,
    brandScope,
  };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'NO_REFUSAL';
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'UNKNOWN';
  }
}

async function scopeOf(membershipId: string): Promise<readonly string[]> {
  const row = await platform.membership.findUniqueOrThrow({ where: { id: membershipId } });
  return row.brandScope;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
  });
  fixtures = await createIsolationFixtures(app);
  memberships = new MembershipService({ prisma: platform });
  invitations = new InvitationService({ prisma: platform });
  analystRoleId = (
    await platform.role.findFirstOrThrow({ where: { key: 'analyst', workspaceId: null } })
  ).id;

  brandTwo = await inA(async (db) => {
    const brand = await db.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        name: 'Brand two',
        slug: `two-${randomUUID().slice(0, 8)}`,
      },
    });
    return brand.id;
  });

  // A colleague in workspace A: workspace B's user, as an analyst.
  const membership = await inA((db) =>
    db.membership.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: fixtures.b.userId,
        roleId: analystRoleId,
        status: 'ACTIVE',
        brandScope: [],
      },
    }),
  );
  colleagueMembershipId = membership.id;
  colleagueUserId = membership.userId;
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('P6-13 · changing a member’s brand access', () => {
  it('narrows a member to named brands, audited before and after', async () => {
    await memberships.changeBrandAccess(fixtures.a.workspaceId, owner(), colleagueMembershipId, [
      fixtures.a.brandId,
    ]);
    expect(await scopeOf(colleagueMembershipId)).toEqual([fixtures.a.brandId]);

    const audit = await platform.auditEvent.findFirst({
      where: {
        workspaceId: fixtures.a.workspaceId,
        action: 'workspace.member.brand_access_changed',
        resourceId: colleagueMembershipId,
      },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.actorId).toBe(fixtures.a.userId);
    expect(audit?.after).toEqual({ brandScope: [fixtures.a.brandId] });

    // And back to every brand.
    await memberships.changeBrandAccess(fixtures.a.workspaceId, owner(), colleagueMembershipId, []);
    expect(await scopeOf(colleagueMembershipId)).toEqual([]);
  });

  it("refuses another workspace's brand exactly like an invented one", async () => {
    const foreign = await refusal(
      memberships.changeBrandAccess(fixtures.a.workspaceId, owner(), colleagueMembershipId, [
        fixtures.b.brandId,
      ]),
    );
    const invented = await refusal(
      memberships.changeBrandAccess(fixtures.a.workspaceId, owner(), colleagueMembershipId, [
        randomUUID(),
      ]),
    );
    expect(foreign).toBe('VALIDATION_FAILED');
    expect(invented).toBe(foreign);
    expect(await scopeOf(colleagueMembershipId)).toEqual([]);
  });

  it('a brand-restricted actor cannot grant ALL brands, nor a brand outside their own', async () => {
    const restricted = owner([fixtures.a.brandId]);
    expect(
      await refusal(
        memberships.changeBrandAccess(
          fixtures.a.workspaceId,
          restricted,
          colleagueMembershipId,
          [],
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await refusal(
        memberships.changeBrandAccess(fixtures.a.workspaceId, restricted, colleagueMembershipId, [
          brandTwo,
        ]),
      ),
    ).toBe('FORBIDDEN');
    // A subset of their own is fine.
    await memberships.changeBrandAccess(fixtures.a.workspaceId, restricted, colleagueMembershipId, [
      fixtures.a.brandId,
    ]);
    expect(await scopeOf(colleagueMembershipId)).toEqual([fixtures.a.brandId]);
    await memberships.changeBrandAccess(fixtures.a.workspaceId, owner(), colleagueMembershipId, []);
  });

  it('the workspace owner is never restricted, and an admin cannot touch the owner', async () => {
    const ownerMembership = await platform.membership.findFirstOrThrow({
      where: { workspaceId: fixtures.a.workspaceId, userId: fixtures.a.userId },
    });
    // Another person with owner authority still cannot narrow the owner...
    expect(
      await refusal(
        memberships.changeBrandAccess(
          fixtures.a.workspaceId,
          { ...owner(), userId: randomUUID() },
          ownerMembership.id,
          [fixtures.a.brandId],
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    // ...the owner cannot narrow themselves (B-5)...
    expect(
      await refusal(
        memberships.changeBrandAccess(fixtures.a.workspaceId, owner(), ownerMembership.id, [
          fixtures.a.brandId,
        ]),
      ),
    ).toBe('FORBIDDEN');
    // ...and an admin — a different person — cannot touch the owner at all.
    expect(
      await refusal(
        memberships.changeBrandAccess(
          fixtures.a.workspaceId,
          { ...owner(), userId: randomUUID(), roleKey: 'workspace_admin' },
          ownerMembership.id,
          [],
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(await scopeOf(ownerMembership.id)).toEqual([]);
  });

  it('needs member.assign_role', async () => {
    expect(
      await refusal(
        memberships.changeBrandAccess(
          fixtures.a.workspaceId,
          { ...owner(), permissionKeys: ['member.read'] },
          colleagueMembershipId,
          [fixtures.a.brandId],
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it("another workspace's membership is a 404 from here", async () => {
    const foreignMembership = await platform.membership.findFirstOrThrow({
      where: { workspaceId: fixtures.b.workspaceId, userId: fixtures.b.userId },
    });
    expect(
      await refusal(
        memberships.changeBrandAccess(fixtures.a.workspaceId, owner(), foreignMembership.id, []),
      ),
    ).toBe('NOT_FOUND');
    expect(await scopeOf(foreignMembership.id)).toEqual([]);
  });

  it('the member list carries each member’s scope for the Team screen', async () => {
    const listed = await memberships.list(fixtures.a.workspaceId);
    const colleague = listed.find((member) => member.userId === colleagueUserId);
    expect(colleague?.brandScope).toEqual([]);
  });
});

describe('P6-13 · an invitation carries brand access, bounded by its inviter', () => {
  const inviter = (brandScope: readonly string[]) => ({
    kind: 'member' as const,
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: OWNER_PERMISSIONS,
    brandScope,
  });

  it('stores the brands it was given, and lists them', async () => {
    const email = `scoped-${randomUUID().slice(0, 8)}@example.local`;
    const issued = await invitations.create({
      workspaceId: fixtures.a.workspaceId,
      email,
      roleId: analystRoleId,
      brandScope: [fixtures.a.brandId],
      inviter: inviter([]),
    });
    const row = await platform.invitation.findUniqueOrThrow({ where: { id: issued.invitationId } });
    expect(row.brandScope).toEqual([fixtures.a.brandId]);
    const listed = (await invitations.list(fixtures.a.workspaceId)).find((i) => i.email === email);
    expect(listed?.brandScope).toEqual([fixtures.a.brandId]);
    expect(listed?.roleNameEn).toBeTruthy();
  });

  it('a brand-restricted inviter can no longer mint an ALL-brands colleague', async () => {
    const code = await refusal(
      invitations.create({
        workspaceId: fixtures.a.workspaceId,
        email: `wide-${randomUUID().slice(0, 8)}@example.local`,
        roleId: analystRoleId,
        brandScope: [],
        inviter: inviter([fixtures.a.brandId]),
      }),
    );
    expect(code).toBe('FORBIDDEN');
  });

  it("refuses another workspace's brand on an invitation", async () => {
    const code = await refusal(
      invitations.create({
        workspaceId: fixtures.a.workspaceId,
        email: `foreign-${randomUUID().slice(0, 8)}@example.local`,
        roleId: analystRoleId,
        brandScope: [fixtures.b.brandId],
        inviter: inviter([]),
      }),
    );
    expect(code).toBe('VALIDATION_FAILED');
  });

  it('a restricted member cannot RESEND an all-brands invitation', async () => {
    const issued = await invitations.create({
      workspaceId: fixtures.a.workspaceId,
      email: `resend-${randomUUID().slice(0, 8)}@example.local`,
      roleId: analystRoleId,
      brandScope: [],
      inviter: inviter([]),
    });
    const code = await refusal(
      invitations.resend(
        fixtures.a.workspaceId,
        issued.invitationId,
        inviter([fixtures.a.brandId]),
      ),
    );
    expect(code).toBe('FORBIDDEN');
    const row = await platform.invitation.findUniqueOrThrow({ where: { id: issued.invitationId } });
    expect(row.status).toBe('PENDING');
  });
});

describe('B-5 · nobody changes their own role or brand access', () => {
  /** The colleague, acting as a workspace admin on their OWN membership. */
  const admin = () => ({
    userId: colleagueUserId,
    roleKey: 'workspace_admin',
    permissionKeys: OWNER_PERMISSIONS,
    brandScope: [] as string[],
  });

  async function ownMembershipId(userId: string): Promise<string> {
    const row = await platform.membership.findFirstOrThrow({
      where: { workspaceId: fixtures.a.workspaceId, userId },
    });
    return row.id;
  }

  async function auditCount(membershipId: string): Promise<number> {
    return platform.auditEvent.count({
      where: {
        workspaceId: fixtures.a.workspaceId,
        resourceId: membershipId,
        action: {
          in: ['workspace.member.role_changed', 'workspace.member.brand_access_changed'],
        },
      },
    });
  }

  it('the owner cannot change their own role, and nothing is written', async () => {
    const mine = await ownMembershipId(fixtures.a.userId);
    const before = await platform.membership.findUniqueOrThrow({ where: { id: mine } });
    const audits = await auditCount(mine);

    expect(
      await refusal(memberships.changeRole(fixtures.a.workspaceId, owner(), mine, analystRoleId)),
    ).toBe('FORBIDDEN');

    const after = await platform.membership.findUniqueOrThrow({ where: { id: mine } });
    expect(after.roleId).toBe(before.roleId);
    expect(await auditCount(mine)).toBe(audits);
  });

  it('an admin cannot raise or change their own role', async () => {
    const ownerRoleId = (
      await platform.role.findFirstOrThrow({ where: { key: 'workspace_owner', workspaceId: null } })
    ).id;
    expect(
      await refusal(
        memberships.changeRole(fixtures.a.workspaceId, admin(), colleagueMembershipId, ownerRoleId),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await refusal(
        memberships.changeRole(
          fixtures.a.workspaceId,
          admin(),
          colleagueMembershipId,
          analystRoleId,
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  it('nobody can change their own brand access, however they would change it', async () => {
    const audits = await auditCount(colleagueMembershipId);
    for (const scope of [[fixtures.a.brandId], [], [brandTwo]]) {
      expect(
        await refusal(
          memberships.changeBrandAccess(
            fixtures.a.workspaceId,
            admin(),
            colleagueMembershipId,
            scope,
          ),
        ),
      ).toBe('FORBIDDEN');
    }
    expect(await auditCount(colleagueMembershipId)).toBe(audits);
  });

  it('changing SOMEBODY ELSE is unaffected', async () => {
    await memberships.changeBrandAccess(fixtures.a.workspaceId, owner(), colleagueMembershipId, [
      fixtures.a.brandId,
    ]);
    expect(await scopeOf(colleagueMembershipId)).toEqual([fixtures.a.brandId]);
    await memberships.changeBrandAccess(fixtures.a.workspaceId, owner(), colleagueMembershipId, []);
  });
});
