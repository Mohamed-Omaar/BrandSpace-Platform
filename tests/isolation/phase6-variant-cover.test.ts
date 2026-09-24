import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { ContentLibraryService, type ContentPolicy } from '@brandspace/content';
import { defaultPayload } from '@brandspace/config';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 6 FINAL · D-285 — A REEL'S COVER IS DURABLE AND STAYS INSIDE ITS BRAND.
 *
 * `content_variant.coverAssetId` is a composite reference into the one Asset
 * Library. Three layers, each tested on its own:
 *   - the SERVICE admits only an IMAGE this variant's brand may use, READY and
 *     CLEAN, and answers a miss the same way whatever the reason;
 *   - the TRIGGER refuses another brand's asset even to a raw write;
 *   - the FOREIGN KEY refuses another workspace's asset, and deleting the asset
 *     clears the cover and nothing else.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let brandOne: string;
let brandTwo: string;
let foreignBrand: string;
let imageOfBrandOne: string;
let sharedImage: string;
let imageOfBrandTwo: string;
let videoOfBrandOne: string;
let foreignImage: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const policy = defaultPayload('content') as unknown as ContentPolicy;
const library = (db: TenantScopedClient) =>
  new ContentLibraryService({ db, workspaceId: fixtures.a.workspaceId, policy });

async function brand(
  workspaceId: string,
  run: <T>(fn: (db: TenantScopedClient) => Promise<T>) => Promise<T>,
  name: string,
): Promise<string> {
  return (
    await run((db) =>
      db.brand.create({
        data: { workspaceId, slug: `p6c-${randomUUID().slice(0, 8)}`, name, status: 'ACTIVE' },
        select: { id: true },
      }),
    )
  ).id;
}

async function asset(
  workspaceId: string,
  run: <T>(fn: (db: TenantScopedClient) => Promise<T>) => Promise<T>,
  overrides: Record<string, unknown>,
): Promise<string> {
  return (
    await run((db) =>
      db.asset.create({
        data: {
          workspaceId,
          name: `cover-${randomUUID().slice(0, 6)}.png`,
          kind: 'IMAGE',
          mimeType: 'image/png',
          sizeBytes: 2_048,
          storageKey: `p6c/${randomUUID()}`,
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

async function reelVariant(brandId: string): Promise<string> {
  return inA(async (db) => {
    const item = await db.contentItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId,
        title: `Reel ${randomUUID().slice(0, 6)}`,
        status: 'DRAFT',
        contentType: 'REEL',
      },
      select: { id: true },
    });
    return (
      await db.contentVariant.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: 'A reel.',
        },
        select: { id: true },
      })
    ).id;
  });
}

const setCover = (variantId: string, coverAssetId: string | null, brandScope: string[] = []) =>
  inA((db) =>
    library(db).editVariant({
      variantId,
      body: 'A reel.',
      coverAssetId,
      actorUserId: fixtures.a.userId,
      actorBrandScope: brandScope,
    }),
  );

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  brandOne = await brand(fixtures.a.workspaceId, inA, 'Cover One');
  brandTwo = await brand(fixtures.a.workspaceId, inA, 'Cover Two');
  foreignBrand = await brand(fixtures.b.workspaceId, inB, 'Cover Foreign');
  imageOfBrandOne = await asset(fixtures.a.workspaceId, inA, { brandId: brandOne });
  sharedImage = await asset(fixtures.a.workspaceId, inA, { brandId: null });
  imageOfBrandTwo = await asset(fixtures.a.workspaceId, inA, { brandId: brandTwo });
  videoOfBrandOne = await asset(fixtures.a.workspaceId, inA, {
    brandId: brandOne,
    kind: 'VIDEO',
    mimeType: 'video/mp4',
  });
  foreignImage = await asset(fixtures.b.workspaceId, inB, { brandId: foreignBrand });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('D-285 · the service', () => {
  it('sets, keeps across an edit that does not name it, and clears a cover', async () => {
    const variantId = await reelVariant(brandOne);
    expect((await setCover(variantId, imageOfBrandOne)).coverAssetId).toBe(imageOfBrandOne);

    // An edit that says nothing about the cover leaves it.
    const kept = await inA((db) =>
      library(db).editVariant({
        variantId,
        body: 'Edited words.',
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      }),
    );
    expect(kept.coverAssetId).toBe(imageOfBrandOne);

    expect((await setCover(variantId, sharedImage)).coverAssetId).toBe(sharedImage);
    expect((await setCover(variantId, null)).coverAssetId).toBeNull();
  });

  it('another brand’s image, another workspace’s image and an unknown id are one miss', async () => {
    const variantId = await reelVariant(brandOne);
    for (const id of [imageOfBrandTwo, foreignImage, randomUUID()]) {
      await expect(setCover(variantId, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('a video is not a cover', async () => {
    const variantId = await reelVariant(brandOne);
    await expect(setCover(variantId, videoOfBrandOne)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('a member scoped to another brand cannot reach the variant at all', async () => {
    const variantId = await reelVariant(brandOne);
    await expect(setCover(variantId, imageOfBrandOne, [brandTwo])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('D-285 · the database, beneath the service', () => {
  it('the trigger refuses another brand’s asset to a raw write', async () => {
    const variantId = await reelVariant(brandOne);
    await expect(
      inA((db) =>
        db.contentVariant.update({
          where: { id: variantId },
          data: { coverAssetId: imageOfBrandTwo },
        }),
      ),
    ).rejects.toThrow(/cover must be an asset/);
  });

  it('the foreign key refuses another workspace’s asset', async () => {
    const variantId = await reelVariant(brandOne);
    await expect(
      inA((db) =>
        db.contentVariant.update({
          where: { id: variantId },
          data: { coverAssetId: foreignImage },
        }),
      ),
    ).rejects.toThrow();
  });

  it('deleting the asset clears the cover and keeps the variant', async () => {
    const variantId = await reelVariant(brandOne);
    const doomed = await asset(fixtures.a.workspaceId, inA, { brandId: brandOne });
    await setCover(variantId, doomed);
    await inA((db) => db.asset.delete({ where: { id: doomed } }));
    const after = await inA((db) =>
      db.contentVariant.findUniqueOrThrow({
        where: { id: variantId },
        select: { coverAssetId: true, body: true },
      }),
    );
    expect(after).toEqual({ coverAssetId: null, body: 'A reel.' });
  });

  it('workspace B cannot read workspace A’s variant or its cover', async () => {
    const variantId = await reelVariant(brandOne);
    await setCover(variantId, imageOfBrandOne);
    const seen = await inB((db) =>
      db.contentVariant.findFirst({ where: { id: variantId }, select: { id: true } }),
    );
    expect(seen).toBeNull();
  });
});
