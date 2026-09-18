import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { ContentMediaResolver, type ContentPolicy } from '@brandspace/content';
import { defaultPayload } from '@brandspace/config';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 8 — MEDIA ON CONTENT, ON REAL POSTGRESQL (AC-27.2, AC-27.5).
 *
 * WHY THIS SUITE EXISTS AT ALL. `ContentVariant.assetIds` is a `String[]` of
 * uuids. An array cannot carry a composite foreign key, so the tenant boundary
 * that protects every other reference in this schema is simply not available
 * here — the schema comment says as much, and says the boundary lives in the
 * SERVICE instead. A boundary that lives in a service is a boundary a test has
 * to prove, because nothing in the database will.
 *
 * SO THESE ASSERT, AGAINST REAL ROWS:
 *   - another workspace's asset cannot be attached, and answers a miss;
 *   - another BRAND's private asset cannot be attached, and answers the same
 *     miss — the cross-brand leak no key expresses;
 *   - the workspace-SHARED shelf CAN be attached, by any brand;
 *   - a quarantined, failed, still-uploading or deleted asset cannot;
 *   - a document is not a picture;
 *   - the member's own BrandScope narrows it further;
 *   - order is preserved, because a carousel's first image is its cover.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

let brandOne: string;
let brandTwo: string;
let foreignBrand: string;

let imageOfBrandOne: string;
let secondImageOfBrandOne: string;
let sharedImage: string;
let imageOfBrandTwo: string;
let foreignImage: string;
let quarantined: string;
let stillUploading: string;
let softDeleted: string;
let documentAsset: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const resolver = (db: TenantScopedClient) =>
  new ContentMediaResolver({ db, workspaceId: fixtures.a.workspaceId });

const policy = defaultPayload('content') as unknown as ContentPolicy;

const makeBrand = async (
  workspaceId: string,
  run: <T>(fn: (db: TenantScopedClient) => Promise<T>) => Promise<T>,
  name: string,
): Promise<string> => {
  const row = await run((db) =>
    db.brand.create({
      data: { workspaceId, slug: `p8m-${randomUUID().slice(0, 8)}`, name, status: 'ACTIVE' },
      select: { id: true },
    }),
  );
  return row.id;
};

const makeAsset = async (
  workspaceId: string,
  run: <T>(fn: (db: TenantScopedClient) => Promise<T>) => Promise<T>,
  overrides: Record<string, unknown>,
): Promise<string> => {
  const row = await run((db) =>
    db.asset.create({
      data: {
        workspaceId,
        name: `media-${randomUUID().slice(0, 6)}.png`,
        kind: 'IMAGE',
        mimeType: 'image/png',
        sizeBytes: 2_048,
        storageKey: `p8m/${randomUUID()}`,
        checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        status: 'READY',
        scanStatus: 'CLEAN',
        ...overrides,
      } as never,
      select: { id: true },
    }),
  );
  return row.id;
};

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);

  brandOne = await makeBrand(fixtures.a.workspaceId, inA, 'Media Alpha');
  brandTwo = await makeBrand(fixtures.a.workspaceId, inA, 'Media Beta');
  foreignBrand = await makeBrand(fixtures.b.workspaceId, inB, 'Media Foreign');

  imageOfBrandOne = await makeAsset(fixtures.a.workspaceId, inA, { brandId: brandOne });
  secondImageOfBrandOne = await makeAsset(fixtures.a.workspaceId, inA, { brandId: brandOne });
  sharedImage = await makeAsset(fixtures.a.workspaceId, inA, { brandId: null });
  imageOfBrandTwo = await makeAsset(fixtures.a.workspaceId, inA, { brandId: brandTwo });
  foreignImage = await makeAsset(fixtures.b.workspaceId, inB, { brandId: foreignBrand });

  quarantined = await makeAsset(fixtures.a.workspaceId, inA, {
    brandId: brandOne,
    scanStatus: 'INFECTED',
  });
  stillUploading = await makeAsset(fixtures.a.workspaceId, inA, {
    brandId: brandOne,
    status: 'UPLOADING',
    scanStatus: 'PENDING',
  });
  softDeleted = await makeAsset(fixtures.a.workspaceId, inA, {
    brandId: brandOne,
    deletedAt: new Date(),
  });
  documentAsset = await makeAsset(fixtures.a.workspaceId, inA, {
    brandId: brandOne,
    kind: 'DOCUMENT',
    mimeType: 'application/pdf',
    name: 'brief.pdf',
  });
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
});

const resolve = (
  assetIds: readonly string[],
  brandId: string,
  brandScope: readonly string[] = [],
) => inA((db) => resolver(db).resolve({ assetIds, brandId, brandScope }));

describe('AC-27.2: only admissible media can be attached', () => {
  it('accepts the brand own image', async () => {
    const media = await resolve([imageOfBrandOne], brandOne);
    expect(media.map((item) => item.id)).toEqual([imageOfBrandOne]);
  });

  it('accepts the workspace-shared shelf, for any brand', async () => {
    expect((await resolve([sharedImage], brandOne)).length).toBe(1);
    expect((await resolve([sharedImage], brandTwo)).length).toBe(1);
  });

  /*
   * THE CROSS-BRAND LEAK NO FOREIGN KEY EXPRESSES. The composite key would have
   * accepted this: both rows are in the same workspace. Only the service says
   * no, which is exactly why this test is here.
   */
  it('refuses another brand private image, as a miss', async () => {
    await expect(resolve([imageOfBrandTwo], brandOne)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses another workspace image, indistinguishably from a fabricated id', async () => {
    await expect(resolve([foreignImage], brandOne)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(resolve([randomUUID()], brandOne)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['quarantined', () => quarantined],
    ['still uploading', () => stillUploading],
    ['soft deleted', () => softDeleted],
  ])('refuses a %s asset', async (_label, id) => {
    await expect(resolve([id()], brandOne)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a document, which is an asset and not a picture', async () => {
    await expect(resolve([documentAsset], brandOne)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses the same asset twice rather than silently de-duplicating it', async () => {
    await expect(resolve([imageOfBrandOne, imageOfBrandOne], brandOne)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('returns nothing for an empty list, without a query', async () => {
    expect(await resolve([], brandOne)).toEqual([]);
  });
});

describe('AC-27.2: BrandScope narrows what may be attached', () => {
  it('refuses a brand the member may not act on at all', async () => {
    await expect(resolve([sharedImage], brandTwo, [brandOne])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('still admits the shared shelf for a scoped member', async () => {
    const media = await resolve([sharedImage], brandOne, [brandOne]);
    expect(media.map((item) => item.id)).toEqual([sharedImage]);
  });
});

describe('AC-27.3: order is content', () => {
  it('returns media in the author order, not the database order', async () => {
    const forward = await resolve([imageOfBrandOne, sharedImage, secondImageOfBrandOne], brandOne);
    expect(forward.map((item) => item.id)).toEqual([
      imageOfBrandOne,
      sharedImage,
      secondImageOfBrandOne,
    ]);

    const reversed = await resolve([secondImageOfBrandOne, sharedImage, imageOfBrandOne], brandOne);
    expect(reversed.map((item) => item.id)).toEqual([
      secondImageOfBrandOne,
      sharedImage,
      imageOfBrandOne,
    ]);
  });
});

describe('AC-27.5: a platform ceiling is enforced before anything is written', () => {
  const forPlatform = (assetIds: readonly string[], platformKey: string) =>
    inA((db) =>
      resolver(db).resolveForPlatform({
        assetIds,
        brandId: brandOne,
        brandScope: [],
        platformKey,
        policy,
      }),
    );

  it('accepts a carousel within the platform limit', async () => {
    const media = await forPlatform([imageOfBrandOne, secondImageOfBrandOne], 'instagram');
    expect(media.length).toBe(2);
  });

  /*
   * TIKTOK TAKES ONE. The number is configuration, not a constant in this test:
   * it is read from the same activated payload the product reads, so an
   * operator raising it raises this too.
   */
  it('refuses more media than the platform accepts', async () => {
    const tiktok = policy.platforms.find((platform) => platform.key === 'tiktok');
    expect(tiktok?.maxMediaItems).toBe(1);
    await expect(
      forPlatform([imageOfBrandOne, secondImageOfBrandOne], 'tiktok'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a platform the operator has not enabled', async () => {
    await expect(forPlatform([imageOfBrandOne], 'myspace')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
