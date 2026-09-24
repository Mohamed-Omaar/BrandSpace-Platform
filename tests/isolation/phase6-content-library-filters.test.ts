import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { ContentLibraryService, parseContentPolicy } from '@brandspace/content';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 6 FINAL · D-282 — THE LIBRARY'S NEW FILTERS NARROW, THEY NEVER WIDEN.
 *
 * Format, platform and language are predicates in the library query. They must
 * intersect with the workspace (RLS) and the member's BrandScope exactly as the
 * brand and status filters do — a filter is not a way to reach rows the
 * member could not otherwise list.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let otherBrandId: string;
let reelInA: string;
let reelInOther: string;
let arabicInA: string;

const library = <T>(fn: (s: ContentLibraryService) => Promise<T>) =>
  withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new ContentLibraryService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: parseContentPolicy(defaultPayload('content')),
        }),
      ),
    { prisma: app },
  );

async function item(
  workspaceId: string,
  brandId: string,
  options: { contentType: 'REEL' | 'POST'; locale: 'AR' | 'EN'; platformKey: string },
): Promise<string> {
  const created = await platform.contentItem.create({
    data: {
      workspaceId,
      brandId,
      title: `Filter ${randomUUID().slice(0, 6)}`,
      status: 'DRAFT',
      contentType: options.contentType,
      primaryLocale: options.locale,
    },
    select: { id: true },
  });
  await platform.contentVariant.create({
    data: {
      workspaceId,
      brandId,
      contentItemId: created.id,
      platformKey: options.platformKey,
      locale: options.locale,
      body: 'x',
      characterCount: 1,
    },
  });
  return created.id;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  const suffix = randomUUID().slice(0, 8);
  otherBrandId = (
    await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        name: `Filters other ${suffix}`,
        slug: `filters-other-${suffix}`,
        status: 'ACTIVE',
        defaultLocale: 'EN',
        supportedLocales: ['EN'],
      },
      select: { id: true },
    })
  ).id;
  reelInA = await item(fixtures.a.workspaceId, fixtures.a.brandId, {
    contentType: 'REEL',
    locale: 'EN',
    platformKey: 'tiktok',
  });
  reelInOther = await item(fixtures.a.workspaceId, otherBrandId, {
    contentType: 'REEL',
    locale: 'EN',
    platformKey: 'tiktok',
  });
  arabicInA = await item(fixtures.a.workspaceId, fixtures.a.brandId, {
    contentType: 'POST',
    locale: 'AR',
    platformKey: 'instagram',
  });
  // Workspace B has a reel on the same platform: it must never appear.
  await item(fixtures.b.workspaceId, fixtures.b.brandId, {
    contentType: 'REEL',
    locale: 'EN',
    platformKey: 'tiktok',
  });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('D-282 · format, platform and language filters', () => {
  it('each narrows to what it names, inside this workspace', async () => {
    const reels = await library((s) => s.listItems({ contentType: 'REEL', limit: 200 }));
    expect(reels.every((row) => row.contentType === 'REEL')).toBe(true);
    expect(reels.map((row) => row.id)).toEqual(expect.arrayContaining([reelInA, reelInOther]));
    expect(reels.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);

    const tiktok = await library((s) => s.listItems({ platformKey: 'tiktok', limit: 200 }));
    expect(tiktok.every((row) => row.variants.some((v) => v.platformKey === 'tiktok'))).toBe(true);

    const arabic = await library((s) => s.listItems({ locale: 'AR', limit: 200 }));
    expect(arabic.map((row) => row.id)).toContain(arabicInA);
    expect(arabic.every((row) => row.primaryLocale === 'AR')).toBe(true);
  });

  it('a filter never widens past the member’s BrandScope', async () => {
    const scoped = await library((s) =>
      s.listItems({
        contentType: 'REEL',
        platformKey: 'tiktok',
        brandScope: [fixtures.a.brandId],
        limit: 200,
      }),
    );
    expect(scoped.map((row) => row.id)).toContain(reelInA);
    expect(scoped.map((row) => row.id)).not.toContain(reelInOther);
    expect(scoped.every((row) => row.brandId === fixtures.a.brandId)).toBe(true);
  });
});
