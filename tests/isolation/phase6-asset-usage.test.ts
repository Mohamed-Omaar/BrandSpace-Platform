import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssetLibraryService, assetPolicyFrom, type AssetActor } from '@brandspace/assets';
import { defaultPayload } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { WORKSPACE_PERMISSIONS } from '@brandspace/shared';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 6 FINAL · D-287 — "USED IN" AND THE LIBRARY'S VIEWS ARE DERIVED, AND
 * THEY NEVER CROSS A WORKSPACE OR A BRANDSCOPE.
 *
 * Usage comes from real references only (`content_variant.assetIds`,
 * `coverAssetId`, brand logos). A post of another brand the reader may not see
 * is not listed as a use; a post in another workspace cannot even be counted;
 * a deleted post is not a use; and the Unused / AI generated / Recent views
 * narrow by real columns.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let brandTwo: string;
let usedInOne: string;
let usedInTwo: string;
let coverOnly: string;
let unused: string;
let generated: string;
let postInOne: string;
let postInTwo: string;

const ALL: readonly string[] = WORKSPACE_PERMISSIONS.map((p) => p.key);
const actor = (overrides: Partial<AssetActor> = {}): AssetActor => ({
  userId: fixtures.a.userId,
  permissionKeys: ALL,
  brandScope: [],
  ...overrides,
});

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const libraryA = <T>(fn: (library: AssetLibraryService) => Promise<T>) =>
  inA((db) =>
    fn(
      new AssetLibraryService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: assetPolicyFrom(defaultPayload('assets')),
      }),
    ),
  );

async function asset(
  workspaceId: string,
  run: typeof inA,
  brandId: string | null,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return (
    await run((db) =>
      db.asset.create({
        data: {
          workspaceId,
          brandId,
          name: `usage-${randomUUID().slice(0, 6)}.png`,
          kind: 'IMAGE',
          mimeType: 'image/png',
          sizeBytes: 1_024,
          storageKey: `p6u/${randomUUID()}`,
          checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          status: 'READY',
          scanStatus: 'CLEAN',
          ...overrides,
        } as never,
        select: { id: true },
      }),
    )
  ).id;
}

async function post(
  workspaceId: string,
  run: typeof inA,
  brandId: string,
  assetIds: string[],
  cover: string | null = null,
): Promise<string> {
  return run(async (db) => {
    const item = await db.contentItem.create({
      data: {
        workspaceId,
        brandId,
        title: `Uses ${randomUUID().slice(0, 6)}`,
        status: 'DRAFT',
        contentType: cover ? 'REEL' : 'POST',
      },
      select: { id: true },
    });
    await db.contentVariant.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: 'x',
        assetIds,
        ...(cover ? { coverAssetId: cover } : {}),
      },
    });
    return item.id;
  });
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  brandTwo = (
    await inA((db) =>
      db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `p6u-${randomUUID().slice(0, 8)}`,
          name: 'Usage Two',
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
    )
  ).id;
  // A SHARED file used by a post of each brand; a file only ever a cover; one
  // nobody uses; one the AI made.
  usedInOne = await asset(fixtures.a.workspaceId, inA, null);
  usedInTwo = usedInOne;
  coverOnly = await asset(fixtures.a.workspaceId, inA, fixtures.a.brandId);
  unused = await asset(fixtures.a.workspaceId, inA, fixtures.a.brandId);
  generated = await asset(fixtures.a.workspaceId, inA, fixtures.a.brandId, {
    source: 'AI_GENERATED',
  });
  postInOne = await post(fixtures.a.workspaceId, inA, fixtures.a.brandId, [usedInOne]);
  postInTwo = await post(fixtures.a.workspaceId, inA, brandTwo, [usedInTwo]);
  await post(fixtures.a.workspaceId, inA, fixtures.a.brandId, [], coverOnly);

  // Workspace B references A's asset id in its own post: it must never count.
  await post(fixtures.b.workspaceId, inB, fixtures.b.brandId, [unused]).catch(() => undefined);
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('D-287 · Used in', () => {
  it('lists the posts that really use a file, covers included', async () => {
    const uses = await libraryA((library) => library.usage(usedInOne, actor()));
    expect(uses.map((use) => use.contentItemId).sort()).toEqual([postInOne, postInTwo].sort());
    const cover = await libraryA((library) => library.usage(coverOnly, actor()));
    expect(cover).toHaveLength(1);
    expect(cover[0]?.asCover).toBe(true);
  });

  it('a post of a brand outside the reader’s scope is not listed', async () => {
    const uses = await libraryA((library) =>
      library.usage(usedInOne, actor({ brandScope: [fixtures.a.brandId] })),
    );
    expect(uses.map((use) => use.contentItemId)).toEqual([postInOne]);
  });

  it('a deleted post is not a use', async () => {
    const doomedAsset = await asset(fixtures.a.workspaceId, inA, fixtures.a.brandId);
    const doomed = await post(fixtures.a.workspaceId, inA, fixtures.a.brandId, [doomedAsset]);
    await inA((db) =>
      db.contentItem.update({ where: { id: doomed }, data: { deletedAt: new Date() } }),
    );
    expect(await libraryA((library) => library.usage(doomedAsset, actor()))).toEqual([]);
  });

  it('another workspace’s file is a miss, not an empty list', async () => {
    const foreign = await asset(fixtures.b.workspaceId, inB, fixtures.b.brandId);
    await expect(libraryA((library) => library.usage(foreign, actor()))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('counts per tile come from this workspace only', async () => {
    const counts = await libraryA((library) => library.usageCounts([usedInOne, coverOnly, unused]));
    expect(counts.get(usedInOne)).toBe(2);
    expect(counts.get(coverOnly)).toBe(1);
    // B's post names `unused` too — RLS keeps it out of A's count.
    expect(counts.get(unused)).toBeUndefined();
  });
});

describe('D-287 · views are filters over real columns', () => {
  it('Unused leaves out every referenced file and keeps the rest', async () => {
    const page = await libraryA((library) =>
      library.browse({ actor: actor(), unusedOnly: true, limit: 100 }),
    );
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(unused);
    expect(ids).not.toContain(usedInOne);
    expect(ids).not.toContain(coverOnly);
  });

  it('AI generated and Recent narrow by source and age', async () => {
    const ai = await libraryA((library) =>
      library.browse({ actor: actor(), sources: ['AI_GENERATED'], limit: 100 }),
    );
    expect(ai.items.every((item) => item.source === 'AI_GENERATED')).toBe(true);
    expect(ai.items.map((item) => item.id)).toContain(generated);

    const future = await libraryA((library) =>
      library.browse({ actor: actor(), createdAfter: new Date('2999-01-01'), limit: 100 }),
    );
    expect(future.items).toEqual([]);
  });
});
