import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_CEILINGS, CustomerAuthService, hashPassword } from '@brandspace/auth';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * FIX PR 2b, B3.2 — A WORKSPACE'S OWN ROLE NO LONGER BREAKS THE LIST.
 *
 * `listWorkspaces` and `listBusinesses` read memberships under the SESSION
 * scope, which carries no workspace context. `role`'s policy shows a
 * context-less read only the system roles, so a membership holding a
 * workspace's custom role joined to null and the whole query threw: the
 * chooser, the switcher and the API context failed for every workspace that
 * person belongs to, not just the one with the custom role.
 *
 * The fix reads each membership's role inside THAT membership's workspace,
 * under the unchanged policy. Against real PostgreSQL through the tenant role:
 *
 *   - a member holding a custom role in A and a system role in B sees both,
 *     each with its own role and permissions, in the list, the switcher's
 *     business list, and after switching;
 *   - the custom role is read only in its own workspace: B's custom role,
 *     which this person does not hold, appears nowhere in what they get back;
 *   - no policy was widened: with no workspace context the tenant role still
 *     cannot read a custom role, and in B's context it cannot read A's.
 */

const PASSWORD = 'a-strong-local-only-test-password-2b32';

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let auth: CustomerAuthService;
let email: string;
let customKey: string;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  auth = new CustomerAuthService({
    prisma: app,
    ceilings: { ...BOOTSTRAP_CEILINGS, signInPerIp: 100_000, signInPerAccount: 100_000 },
  });

  const custom = await platform.role.findUniqueOrThrow({
    where: { id: fixtures.a.customRoleId },
    select: { key: true },
  });
  customKey = custom.key;
  const permission = await platform.permission.findUniqueOrThrow({
    where: { key: 'content.read' },
    select: { id: true },
  });
  await platform.rolePermission.upsert({
    where: {
      roleId_permissionId: { roleId: fixtures.a.customRoleId, permissionId: permission.id },
    },
    create: { roleId: fixtures.a.customRoleId, permissionId: permission.id },
    update: {},
  });
  const admin = await platform.role.findFirstOrThrow({
    where: { key: 'workspace_admin', workspaceId: null, realm: 'WORKSPACE' },
    select: { id: true },
  });

  email = `custom-role-${randomUUID().slice(0, 8)}@example.local`;
  const user = await platform.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      timezone: 'UTC',
    },
  });
  for (const [workspaceId, roleId] of [
    [fixtures.a.workspaceId, fixtures.a.customRoleId],
    [fixtures.b.workspaceId, admin.id],
  ] as const) {
    await platform.membership.create({
      data: {
        workspaceId,
        userId: user.id,
        roleId,
        status: 'ACTIVE',
        acceptedAt: new Date(),
        brandScope: [],
      },
    });
  }
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('B3.2 — the workspace list resolves a custom role inside its own workspace', () => {
  it('lists both workspaces, each with its own role and permissions', async () => {
    const session = await auth.signIn({ email, password: PASSWORD });
    const listed = await auth.listWorkspaces(session.token);
    const inA = listed.find((w) => w.workspaceId === fixtures.a.workspaceId);
    const inB = listed.find((w) => w.workspaceId === fixtures.b.workspaceId);
    expect(inA?.roleKey).toBe(customKey);
    expect(inA?.permissionKeys).toEqual(['content.read']);
    expect(inB?.roleKey).toBe('workspace_admin');
    expect(inB?.permissionKeys.length).toBeGreaterThan(0);
  });

  it("the switcher's business list carries both, and switching into A uses A's custom role", async () => {
    const session = await auth.signIn({ email, password: PASSWORD });
    const businesses = await auth.listBusinesses(session.token);
    expect(businesses.map((b) => [b.workspaceId, b.roleKey]).sort()).toEqual(
      [
        [fixtures.a.workspaceId, customKey],
        [fixtures.b.workspaceId, 'workspace_admin'],
      ].sort(),
    );
    const switched = await auth.switchWorkspace(session.token, fixtures.a.workspaceId);
    expect(switched.roleKey).toBe(customKey);
    expect(switched.permissionKeys).toEqual(['content.read']);
    const resolved = await auth.resolve(session.token);
    expect(resolved).not.toBeNull();
  });

  it("never returns B's custom role, which this person does not hold", async () => {
    const otherCustom = await platform.role.findUniqueOrThrow({
      where: { id: fixtures.b.customRoleId },
      select: { key: true },
    });
    const session = await auth.signIn({ email, password: PASSWORD });
    const everything = JSON.stringify([
      await auth.listWorkspaces(session.token),
      await auth.listBusinesses(session.token),
    ]);
    expect(everything).not.toContain(otherCustom.key);
    expect(everything).not.toContain(fixtures.b.customRoleId);
  });

  it('widens no policy: a custom role stays unreadable outside its own workspace', async () => {
    const read = (workspaceId: string) =>
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        return tx.role.findUnique({ where: { id: fixtures.a.customRoleId } });
      });
    await expect(read('')).resolves.toBeNull();
    await expect(read(fixtures.b.workspaceId)).resolves.toBeNull();
    await expect(read(fixtures.a.workspaceId)).resolves.not.toBeNull();
  });
});
