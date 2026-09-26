import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { countPublishedPosts } from '@brandspace/analytics';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * F5 — Home and Performance count published POSTS from one live list.
 *
 * A post sent to two channels is one post; an archived or expired post is not
 * counted; a member scoped to one brand counts only that brand; another
 * workspace's posts are never counted. Every row is written through the tenant
 * client under RLS, in a brand of this suite's own so other suites' fixtures
 * cannot move the numbers.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let brandId: string;
let otherBrandId: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });

const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
const WINDOW = { start: daysAgo(28), end: now };

async function makeBrand(name: string): Promise<string> {
  const row = await inA((db) =>
    db.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `f5-${randomUUID().slice(0, 8)}`,
        name,
        status: 'ACTIVE',
      },
      select: { id: true },
    }),
  );
  return row.id;
}

/** A post in `brand`, published on each of `channels` at `publishedAt`. */
async function publishedPost(
  brand: string,
  channels: number,
  publishedAt: Date,
  item: { status?: 'PUBLISHED' | 'ARCHIVED'; deletedAt?: Date | null } = {},
): Promise<string> {
  return inA(async (db) => {
    const post = await db.contentItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: brand,
        title: `F5 ${randomUUID().slice(0, 6)}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: item.status ?? 'PUBLISHED',
        deletedAt: item.deletedAt ?? null,
      },
      select: { id: true },
    });
    for (let channel = 0; channel < channels; channel += 1) {
      await db.publishJob.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: brand,
          calendarSlotId: fixtures.a.calendarSlotId,
          contentItemId: post.id,
          contentVariantId: fixtures.a.contentVariantId,
          socialConnectionId: fixtures.a.socialConnectionId,
          provider: channel === 0 ? 'INSTAGRAM' : 'TIKTOK',
          status: 'PUBLISHED',
          idempotencyKey: `f5-${randomUUID()}`,
          scheduledAtUtc: publishedAt,
          maxAttempts: 5,
          externalPostId: `f5-post-${randomUUID().slice(0, 8)}`,
          publishedAt,
        },
      });
    }
    return post.id;
  });
}

const count = (scope: { brandId?: string; brandScope?: readonly string[] } = {}) =>
  inA((db) =>
    countPublishedPosts(db, {
      workspaceId: fixtures.a.workspaceId,
      brandId: scope.brandId,
      brandScope: scope.brandScope ?? [],
      period: WINDOW,
    }),
  );

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  brandId = await makeBrand('F5 main');
  otherBrandId = await makeBrand('F5 other');
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('F5 · one live count of published posts', () => {
  it('a post published on two channels counts once', async () => {
    const before = await count({ brandId });
    await publishedPost(brandId, 2, daysAgo(3));
    expect(await count({ brandId })).toBe(before + 1);
  });

  it('an archived post and an expired (deleted) post count zero', async () => {
    const before = await count({ brandId });
    await publishedPost(brandId, 1, daysAgo(2), { status: 'ARCHIVED' });
    await publishedPost(brandId, 1, daysAgo(2), { deletedAt: daysAgo(1) });
    expect(await count({ brandId })).toBe(before);
  });

  it('a post published before the window is not in it', async () => {
    const before = await count({ brandId });
    await publishedPost(brandId, 1, daysAgo(40));
    expect(await count({ brandId })).toBe(before);
  });

  it('a member scoped to one brand counts only that brand', async () => {
    await publishedPost(otherBrandId, 1, daysAgo(1));
    const mainOnly = await count({ brandScope: [brandId] });
    expect(mainOnly).toBe(await count({ brandId }));
    expect(await count({ brandScope: [brandId, otherBrandId] })).toBe(mainOnly + 1);
  });

  it('another workspace never counts anything of this one', async () => {
    const fromB = await withWorkspace(
      fixtures.b.workspaceId,
      (db) =>
        countPublishedPosts(db, {
          workspaceId: fixtures.a.workspaceId,
          brandId,
          brandScope: [],
          period: WINDOW,
        }),
      { prisma: app },
    );
    expect(fromB).toBe(0);
  });
});
