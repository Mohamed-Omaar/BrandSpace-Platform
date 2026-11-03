import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { TOOL_EXECUTORS } from '@brandspace/copilot';
import { systemClock } from '@brandspace/shared';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PR B (D-594) — THE COPILOT'S WORKSPACE READS, AGAINST REAL POSTGRESQL.
 *
 * "Who is on my team", "how many credits", "which channels" and "my
 * notifications" are answered from these tools. Each must read only the
 * caller's workspace (application layer AND row-level security), channels
 * only inside the caller's BrandScope, and notifications only the caller's
 * own. That they write nothing is `copilot-read-only.test.ts`, which runs every
 * READ_ONLY tool against a client that refuses writes.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let secondBrandA: string;
let colleagueId: string;

type Result = Record<string, unknown>;

async function read(
  toolKey: string,
  input: {
    /** The workspace the session is bound to (RLS). */
    session: string;
    /** The workspace the tool is told it is in (application layer). */
    workspaceId?: string;
    userId: string;
    brandScope?: string[];
  },
): Promise<Result> {
  const executor = TOOL_EXECUTORS[toolKey];
  if (!executor) throw new Error(`${toolKey} has no executor`);
  return withWorkspace(
    input.session,
    async (db) =>
      (
        await executor(
          {
            db: db as TenantScopedClient,
            workspaceId: input.workspaceId ?? input.session,
            authorization: {
              userId: input.userId,
              roleKey: 'workspace_owner',
              permissionKeys: ['copilot.use'],
              brandScope: input.brandScope ?? [],
            },
            clock: systemClock,
          } as never,
          {},
        )
      ).result as Result,
    { prisma: app },
  ) as Promise<Result>;
}

async function connection(workspaceId: string, brandId: string, name: string): Promise<void> {
  await platform.socialConnection.create({
    data: {
      workspaceId,
      brandId,
      provider: 'INSTAGRAM',
      externalAccountId: `acct-${randomUUID()}`,
      displayName: name,
      targetKind: 'business_account',
      status: 'ACTIVE',
    } as never,
  });
}

async function notify(workspaceId: string, userId: string, templateKey: string): Promise<void> {
  await platform.notification.create({
    data: { workspaceId, userId, templateKey, idempotencyKey: `n-${randomUUID()}` },
  });
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  secondBrandA = (
    await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `reads-${randomUUID().slice(0, 8)}`,
        name: 'Second brand',
        status: 'ACTIVE',
      },
      select: { id: true },
    })
  ).id;
  colleagueId = (
    await platform.user.create({
      data: {
        email: `colleague-${randomUUID()}@example.test`,
        name: 'Colleague A',
        timezone: 'UTC',
      },
      select: { id: true },
    })
  ).id;
  const role = await platform.membership.findUniqueOrThrow({
    where: { id: fixtures.a.membershipId },
    select: { roleId: true },
  });
  await platform.membership.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      userId: colleagueId,
      roleId: role.roleId,
      status: 'ACTIVE',
    },
  });
  await platform.user.update({
    where: { id: fixtures.b.userId },
    data: { name: 'Owner of B' },
  });
  await connection(fixtures.a.workspaceId, fixtures.a.brandId, 'A main');
  await connection(fixtures.a.workspaceId, secondBrandA, 'A second');
  await connection(fixtures.b.workspaceId, fixtures.b.brandId, 'B main');
  await notify(fixtures.a.workspaceId, fixtures.a.userId, 'approval.requested');
  await notify(fixtures.a.workspaceId, colleagueId, 'approval.approved');
  await notify(fixtures.b.workspaceId, fixtures.b.userId, 'approval.rejected');
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('PR B — the Copilot reads the workspace, and only its own', () => {
  it('team.list: this workspace’s members, never another’s', async () => {
    const team = await read('team.list', {
      session: fixtures.a.workspaceId,
      userId: fixtures.a.userId,
    });
    const names = (team['members'] as { name: string | null }[]).map((m) => m.name);
    expect(names).toContain('Colleague A');
    expect(names).not.toContain('Owner of B');
    expect(team['activeCount']).toBe(
      await platform.membership.count({
        where: { workspaceId: fixtures.a.workspaceId, status: 'ACTIVE' },
      }),
    );
    expect(team).toMatchObject({ source: 'team' });
    expect(typeof team['asOf']).toBe('string');
    // Names and roles only: never an email.
    expect(JSON.stringify(team)).not.toContain('@example.test');
  });

  it('credits.balance: this workspace’s wallet, with its source', async () => {
    const credits = await read('credits.balance', {
      session: fixtures.a.workspaceId,
      userId: fixtures.a.userId,
    });
    const wallet = await platform.creditWallet.findUniqueOrThrow({
      where: { workspaceId: fixtures.a.workspaceId },
      select: { balanceMilliCredits: true },
    });
    expect(credits['balanceCredits']).toBe(Number(wallet.balanceMilliCredits / 1000n));
    expect(credits['source']).toBe('credit_ledger');
  });

  it('channels.list: inside the caller’s BrandScope, and never another workspace’s', async () => {
    const all = await read('channels.list', {
      session: fixtures.a.workspaceId,
      userId: fixtures.a.userId,
    });
    const names = (all['channels'] as { name: string }[]).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['A main', 'A second']));
    expect(names).not.toContain('B main');
    expect(all['count']).toBe(
      await platform.socialConnection.count({
        where: {
          workspaceId: fixtures.a.workspaceId,
          status: { in: ['ACTIVE', 'NEEDS_REAUTH', 'DISABLED'] },
        },
      }),
    );
    const scoped = await read('channels.list', {
      session: fixtures.a.workspaceId,
      userId: fixtures.a.userId,
      brandScope: [secondBrandA],
    });
    expect((scoped['channels'] as { name: string }[]).map((c) => c.name)).toEqual(['A second']);
  });

  it('notifications.recent: the caller’s own inbox only', async () => {
    const mine = await read('notifications.recent', {
      session: fixtures.a.workspaceId,
      userId: fixtures.a.userId,
    });
    const own = { workspaceId: fixtures.a.workspaceId, userId: fixtures.a.userId };
    expect(mine['unreadCount']).toBe(
      await platform.notification.count({ where: { ...own, readAt: null } }),
    );
    expect((mine['items'] as unknown[]).length).toBe(
      Math.min(10, await platform.notification.count({ where: own })),
    );
    // The colleague's notification is theirs: their count, not the caller's.
    const colleague = await read('notifications.recent', {
      session: fixtures.a.workspaceId,
      userId: colleagueId,
    });
    expect(colleague['unreadCount']).toBe(1);
    expect((colleague['items'] as { templateKey: string }[]).map((i) => i.templateKey)).toEqual([
      'approval.approved',
    ]);
  });

  it('a session bound to workspace B reads nothing of A, even when told A (RLS)', async () => {
    for (const toolKey of ['team.list', 'channels.list', 'notifications.recent']) {
      const crossed = await read(toolKey, {
        session: fixtures.b.workspaceId,
        workspaceId: fixtures.a.workspaceId,
        userId: fixtures.a.userId,
      });
      const rows = (crossed['members'] ?? crossed['channels'] ?? crossed['items']) as unknown[];
      expect(rows, toolKey).toEqual([]);
    }
    const credits = await read('credits.balance', {
      session: fixtures.b.workspaceId,
      workspaceId: fixtures.a.workspaceId,
      userId: fixtures.a.userId,
    });
    expect(credits['balanceCredits']).toBeUndefined();
    const plan = await read('plan.summary', {
      session: fixtures.b.workspaceId,
      workspaceId: fixtures.a.workspaceId,
      userId: fixtures.a.userId,
    });
    expect(plan['planKey']).toBeUndefined();
  });
});
