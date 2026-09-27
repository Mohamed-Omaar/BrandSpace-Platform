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
 * B14 (Phase 2B-2b) — THE COPILOT'S `approvals.summary`, AGAINST REAL
 * POSTGRESQL. That it writes nothing is `copilot-read-only.test.ts`, which runs
 * every READ_ONLY tool against a client that refuses writes. This proves what
 * it reads: only PENDING cycles of live posts, on the named brand, inside the
 * caller's scope, in the caller's workspace.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let brandId: string;
let otherBrandId: string;
let otherUserId: string;

async function brand(name: string): Promise<string> {
  return (
    await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `${name}-${randomUUID().slice(0, 8)}`,
        name,
        status: 'ACTIVE',
      },
      select: { id: true },
    })
  ).id;
}

async function approval(input: {
  brand: string;
  assignedToUserId?: string | null;
  status?: 'PENDING' | 'APPROVED';
  deleted?: boolean;
  title?: string;
}): Promise<string> {
  const item = await platform.contentItem.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: input.brand,
      title: input.title ?? `Post ${randomUUID().slice(0, 6)}`,
      contentType: 'POST',
      primaryLocale: 'EN',
      status: 'IN_REVIEW',
      createdByUserId: otherUserId,
      ...(input.deleted ? { deletedAt: new Date() } : {}),
    } as never,
    select: { id: true },
  });
  const row = await platform.approval.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: input.brand,
      contentItemId: item.id,
      requestedByUserId: otherUserId,
      assignedToUserId: input.assignedToUserId ?? null,
      status: input.status ?? 'PENDING',
      ...(input.status === 'APPROVED'
        ? { decidedAt: new Date(), decidedByUserId: fixtures.a.userId }
        : {}),
    },
    select: { id: true },
  });
  return row.id;
}

type Summary = {
  brandId: string;
  pendingCount: number;
  assignedToYouCount: number;
  unassignedCount: number;
  oldestPendingAt: string | null;
  items: {
    approvalId: string;
    title: string | null;
    assignedToYou: boolean;
    unassigned: boolean;
  }[];
};

async function summarise(input: {
  workspaceId: string;
  userId: string;
  brandId: string;
  brandScope?: string[];
}): Promise<Summary> {
  const executor = TOOL_EXECUTORS['approvals.summary'];
  if (!executor) throw new Error('approvals.summary has no executor');
  return withWorkspace(
    input.workspaceId,
    async (db) => {
      const outcome = await executor(
        {
          db: db as TenantScopedClient,
          workspaceId: input.workspaceId,
          authorization: {
            userId: input.userId,
            roleKey: 'workspace_owner',
            permissionKeys: ['copilot.use', 'content.read'],
            brandScope: input.brandScope ?? [],
          },
          clock: systemClock,
        } as never,
        { brandId: input.brandId },
      );
      return outcome.result as Summary;
    },
    { prisma: app },
  ) as Promise<Summary>;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  brandId = await brand('approvals-summary');
  otherBrandId = await brand('approvals-other');
  otherUserId = (
    await platform.user.create({
      data: { email: `requester-${randomUUID()}@example.test`, timezone: 'UTC' },
      select: { id: true },
    })
  ).id;

  await approval({ brand: brandId, assignedToUserId: fixtures.a.userId, title: 'Mine' });
  await approval({ brand: brandId, assignedToUserId: null, title: 'Anyone' });
  await approval({ brand: brandId, assignedToUserId: otherUserId, title: 'Theirs' });
  await approval({ brand: brandId, status: 'APPROVED', title: 'Decided' });
  await approval({ brand: brandId, deleted: true, title: 'Deleted' });
  await approval({ brand: otherBrandId, title: 'Other brand' });
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('approvals.summary', () => {
  it('counts the PENDING cycles of live posts on this brand, and who they are for', async () => {
    const summary = await summarise({
      workspaceId: fixtures.a.workspaceId,
      userId: fixtures.a.userId,
      brandId,
    });
    expect(summary).toMatchObject({
      brandId,
      pendingCount: 3,
      assignedToYouCount: 1,
      unassignedCount: 1,
    });
    expect(summary.items.map((item) => item.title).sort()).toEqual(['Anyone', 'Mine', 'Theirs']);
    expect(summary.items.find((item) => item.title === 'Mine')).toMatchObject({
      assignedToYou: true,
      unassigned: false,
    });
    expect(summary.oldestPendingAt).not.toBeNull();
  });

  it('carries no person’s identity and no reviewer’s words', async () => {
    const summary = await summarise({
      workspaceId: fixtures.a.workspaceId,
      userId: fixtures.a.userId,
      brandId,
    });
    const text = JSON.stringify(summary);
    expect(text).not.toContain(otherUserId);
    expect(text).not.toContain(fixtures.a.userId);
    for (const item of summary.items) {
      expect(Object.keys(item).sort()).toEqual([
        'approvalId',
        'assignedToYou',
        'contentItemId',
        'cycle',
        'itemStatus',
        'requestedAt',
        'title',
        'unassigned',
      ]);
    }
  });

  it('a member restricted to another brand reads nothing from this one', async () => {
    const summary = await summarise({
      workspaceId: fixtures.a.workspaceId,
      userId: fixtures.a.userId,
      brandId,
      brandScope: [otherBrandId],
    });
    expect(summary.pendingCount).toBe(0);
    expect(summary.items).toEqual([]);
  });

  it('another workspace naming this brand reads nothing', async () => {
    const summary = await summarise({
      workspaceId: fixtures.b.workspaceId,
      userId: fixtures.b.userId,
      brandId,
    });
    expect(summary.pendingCount).toBe(0);
    expect(summary.items).toEqual([]);
  });
});
