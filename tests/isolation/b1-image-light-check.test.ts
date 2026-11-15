import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_CEILINGS, CustomerAuthService, hashPassword } from '@brandspace/auth';
import { appRoleClient } from './fixtures';

/**
 * B1 (performance, owner 2026-11-14) — THE IMAGE ROUTE'S LIGHT CHECK, AGAINST
 * REAL POSTGRESQL.
 *
 * `/assets/file/<grant>` no longer resolves the whole session and every
 * workspace for each tile; it asks `canReadInActiveWorkspace(session, the
 * grant's workspace, 'assets.read')`. It must refuse everything the full path
 * refuses: another workspace (even one this person belongs to but is not
 * working in), no membership, a suspended membership or workspace, a workspace
 * being deleted, a missing permission, a signed-out session, two-step not
 * passed, and a workspace that requires two-step for a person without it.
 */

const PASSWORD = 'a-strong-local-only-test-password-b1';

let app: PrismaClient;
let platform: PrismaClient;

/** A fresh documentation address per sign-in, so the per-address limit never trips. */
const anIp = () => `2001:db8::${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}`;

const auth = () => new CustomerAuthService({ prisma: app, ceilings: BOOTSTRAP_CEILINGS });

async function person(): Promise<{ id: string; email: string }> {
  return platform.user.create({
    data: {
      email: `b1-img-${randomUUID()}@example.test`,
      name: 'Image viewer',
      locale: 'EN',
      timezone: 'UTC',
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
    },
    select: { id: true, email: true },
  });
}

async function workspaceFor(userId: string, requireMfa = false): Promise<string> {
  const id = randomUUID();
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `b1-img-${id.slice(0, 12)}`,
      name: `B1 ${id.slice(0, 6)}`,
      ownerUserId: userId,
      status: 'ACTIVE',
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      requireMfa,
    },
  });
  const role = await platform.role.findFirstOrThrow({
    where: { key: 'workspace_owner', workspaceId: null },
    select: { id: true },
  });
  await platform.membership.create({
    data: { workspaceId: id, userId, roleId: role.id, status: 'ACTIVE', acceptedAt: new Date() },
  });
  return id;
}

/** A signed-in session working in `workspaceId`. */
async function working(email: string, workspaceId: string): Promise<string> {
  const { token } = await auth().signIn({ email, password: PASSWORD, ip: anIp() });
  await auth().switchWorkspace(token, workspaceId);
  return token;
}

beforeAll(() => {
  app = appRoleClient();
  platform = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
  });
});

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('B1 · an image is served only inside the workspace the session is working in', () => {
  it('its own active workspace with assets.read: allowed', async () => {
    const me = await person();
    const mine = await workspaceFor(me.id);
    const token = await working(me.email, mine);
    expect(await auth().canReadInActiveWorkspace(token, mine, 'assets.read')).toBe(true);
  });

  it('another workspace is refused — even one this person belongs to but is not working in', async () => {
    const me = await person();
    const mine = await workspaceFor(me.id);
    const alsoMine = await workspaceFor(me.id);
    const stranger = await person();
    const theirs = await workspaceFor(stranger.id);
    const token = await working(me.email, mine);
    expect(await auth().canReadInActiveWorkspace(token, alsoMine, 'assets.read')).toBe(false);
    expect(await auth().canReadInActiveWorkspace(token, theirs, 'assets.read')).toBe(false);
  });

  it('a permission the role does not hold is refused', async () => {
    const me = await person();
    const mine = await workspaceFor(me.id);
    const token = await working(me.email, mine);
    expect(await auth().canReadInActiveWorkspace(token, mine, 'no.such.permission')).toBe(false);
  });

  it('a suspended membership, a suspended workspace, a workspace being deleted: refused', async () => {
    for (const change of ['membership', 'workspace', 'deletion'] as const) {
      const me = await person();
      const mine = await workspaceFor(me.id);
      const token = await working(me.email, mine);
      if (change === 'membership') {
        await platform.membership.updateMany({
          where: { workspaceId: mine, userId: me.id },
          data: { status: 'SUSPENDED' },
        });
      } else if (change === 'workspace') {
        await platform.workspace.update({
          where: { id: mine },
          data: { status: 'SUSPENDED', statusReason: 'B1 isolation test' },
        });
      } else {
        await platform.workspace.update({
          where: { id: mine },
          data: {
            deletionRequestedAt: new Date(),
            deletionScheduledFor: new Date(Date.now() + 86_400_000),
          },
        });
      }
      expect(await auth().canReadInActiveWorkspace(token, mine, 'assets.read')).toBe(false);
    }
  });

  it('a signed-out session, an expired one, or no session at all: refused', async () => {
    const me = await person();
    const mine = await workspaceFor(me.id);
    const token = await working(me.email, mine);
    await auth().signOut(token);
    expect(await auth().canReadInActiveWorkspace(token, mine, 'assets.read')).toBe(false);
    expect(await auth().canReadInActiveWorkspace('', mine, 'assets.read')).toBe(false);

    const again = await working(me.email, mine);
    await platform.customerSession.updateMany({
      where: { userId: me.id, revokedAt: null },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await auth().canReadInActiveWorkspace(again, mine, 'assets.read')).toBe(false);
  });

  it('two-step: switched on but not passed in this session, or required by the workspace and not set up: refused', async () => {
    // Two-step is on; this session signed in with the password and never
    // passed the second step (a placeholder reference satisfies the row's own
    // coherence rule). The active workspace is set directly: the point is that
    // the light check refuses even then.
    const me = await person();
    const mine = await workspaceFor(me.id);
    await platform.user.update({
      where: { id: me.id },
      data: { mfaEnabled: true, mfaSecretRef: `b1-test-${randomUUID()}` },
    });
    const { token, mfaRequired } = await auth().signIn({
      email: me.email,
      password: PASSWORD,
      ip: anIp(),
    });
    expect(mfaRequired).toBe(true);
    await platform.customerSession.updateMany({
      where: { userId: me.id, revokedAt: null },
      data: { activeWorkspaceId: mine },
    });
    expect(await auth().canReadInActiveWorkspace(token, mine, 'assets.read')).toBe(false);

    const other = await person();
    const strict = await workspaceFor(other.id, true);
    const session = await working(other.email, strict).catch(async () => {
      // A workspace that requires two-step may refuse the switch itself; set
      // the active workspace directly to prove the light check refuses too.
      const { token: raw } = await auth().signIn({
        email: other.email,
        password: PASSWORD,
        ip: anIp(),
      });
      await platform.customerSession.updateMany({
        where: { userId: other.id, revokedAt: null },
        data: { activeWorkspaceId: strict },
      });
      return raw;
    });
    expect(await auth().canReadInActiveWorkspace(session, strict, 'assets.read')).toBe(false);
  });
});
