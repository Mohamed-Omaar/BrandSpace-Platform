import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { ContentLibraryService, readSlides, type ContentPolicy } from '@brandspace/content';
import { defaultPayload } from '@brandspace/config';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * B9 (Phase 2B-2) — CAROUSEL SLIDE HEADLINES, AGAINST REAL POSTGRESQL.
 *
 * A slide is {image, headline} (owner answer D3). The images stay
 * `assetIds`; the headlines live in `content_variant.slides`, keyed by image,
 * so they follow a reorder and leave with a removed image. Slides are part of
 * the post: the read-only and approval rules that guard its words guard them.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let brandId: string;
let images: string[];
let platformKey: string;

const policy = defaultPayload('content') as unknown as ContentPolicy;
const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const library = (db: TenantScopedClient) =>
  new ContentLibraryService({ db, workspaceId: fixtures.a.workspaceId, policy });

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  const carrier = policy.platforms.find((p) => p.maxMediaItems >= 3);
  if (!carrier) throw new Error('the default content policy needs a channel that takes 3 images');
  platformKey = carrier.key;
  brandId = (
    await inA((db) =>
      db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `slides-${randomUUID().slice(0, 8)}`,
          name: 'Slides brand',
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
    )
  ).id;
  images = [];
  for (let index = 0; index < 3; index += 1) {
    images.push(
      (
        await inA((db) =>
          db.asset.create({
            data: {
              workspaceId: fixtures.a.workspaceId,
              brandId,
              name: `slide-${index}.png`,
              kind: 'IMAGE',
              mimeType: 'image/png',
              sizeBytes: 2_048,
              storageKey: `slides/${randomUUID()}`,
              checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
              status: 'READY',
              scanStatus: 'CLEAN',
            } as never,
            select: { id: true },
          }),
        )
      ).id,
    );
  }
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

async function carousel(): Promise<{ itemId: string; variantId: string }> {
  const created = await inA((db) =>
    library(db).createManualItem({
      brandId,
      title: 'Three slides',
      contentType: 'CAROUSEL',
      locale: 'EN',
      variants: [{ platformKey, body: 'Swipe', assetIds: images }],
      actorUserId: fixtures.a.userId,
      actorBrandScope: [],
      expiresAt: null,
      idempotencyKey: `slides-${randomUUID()}`,
    }),
  );
  return { itemId: created.item.id, variantId: created.variants[0]!.id };
}

const edit = (variantId: string, extra: Record<string, unknown>) =>
  inA((db) =>
    library(db).editVariant({
      variantId,
      body: 'Swipe',
      actorUserId: fixtures.a.userId,
      actorBrandScope: [],
      actorPermissionKeys: ['content.edit', 'content.schedule'],
      ...extra,
    }),
  );

const stored = async (variantId: string) =>
  readSlides(
    (await platform.contentVariant.findUniqueOrThrow({ where: { id: variantId } })).slides,
  );

describe('slide headlines', () => {
  it('are stored in the images order, blank ones left out', async () => {
    const { variantId } = await carousel();
    await edit(variantId, {
      slides: [
        { assetId: images[2]!, headline: '  Three  ' },
        { assetId: images[0]!, headline: 'One' },
        { assetId: images[1]!, headline: '   ' },
      ],
    });
    expect(await stored(variantId)).toEqual([
      { assetId: images[0], headline: 'One' },
      { assetId: images[2], headline: 'Three' },
    ]);
  });

  it('follow a reorder and leave with a removed image', async () => {
    const { variantId } = await carousel();
    await edit(variantId, {
      slides: images.map((assetId, index) => ({ assetId, headline: `H${index}` })),
    });
    await edit(variantId, { assetIds: [images[2], images[0]] });
    expect(await stored(variantId)).toEqual([
      { assetId: images[2], headline: 'H2' },
      { assetId: images[0], headline: 'H0' },
    ]);
  });

  it('a variant with no headlines keeps NULL, like one written before slides existed', async () => {
    const { variantId } = await carousel();
    await edit(variantId, { slides: [{ assetId: images[0]!, headline: '' }] });
    const row = await platform.contentVariant.findUniqueOrThrow({ where: { id: variantId } });
    expect(row.slides).toBeNull();
  });

  it('refuses a headline over the limit and writes nothing', async () => {
    const { variantId } = await carousel();
    await expect(
      edit(variantId, { slides: [{ assetId: images[0]!, headline: 'x'.repeat(121) }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await stored(variantId)).toEqual([]);
  });

  it('the database refuses a slides value that is not an array', async () => {
    const { variantId } = await carousel();
    await expect(
      platform.contentVariant.update({
        where: { id: variantId },
        data: { slides: { assetId: images[0], headline: 'x' } },
      }),
    ).rejects.toThrow();
  });

  it('changing a headline on an approved post takes the approval back, like any edit (F1)', async () => {
    const { itemId, variantId } = await carousel();
    await platform.contentItem.update({ where: { id: itemId }, data: { status: 'APPROVED' } });
    await edit(variantId, { slides: [{ assetId: images[0]!, headline: 'Changed' }] });
    const item = await platform.contentItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.status).toBe('DRAFT');
  });

  it('a published post’s headlines are read-only (B-2)', async () => {
    const { itemId, variantId } = await carousel();
    await platform.contentItem.update({ where: { id: itemId }, data: { status: 'PUBLISHED' } });
    await expect(
      edit(variantId, { slides: [{ assetId: images[0]!, headline: 'Late change' }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await stored(variantId)).toEqual([]);
  });

  it('travel with a copy ("Make a new copy")', async () => {
    const copy = await inA((db) =>
      library(db).createManualItem({
        brandId,
        title: 'Copy',
        contentType: 'CAROUSEL',
        locale: 'EN',
        variants: [
          {
            platformKey,
            body: 'Swipe',
            assetIds: images,
            slides: [{ assetId: images[1]!, headline: 'Kept' }],
          },
        ],
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        expiresAt: null,
        idempotencyKey: `slides-copy-${randomUUID()}`,
      }),
    );
    expect(readSlides(copy.variants[0]!.slides)).toEqual([
      { assetId: images[1], headline: 'Kept' },
    ]);
  });

  it('another workspace cannot read or write them', async () => {
    const { variantId } = await carousel();
    const fromB = await withWorkspace(
      fixtures.b.workspaceId,
      (db) => db.contentVariant.findFirst({ where: { id: variantId }, select: { slides: true } }),
      { prisma: app },
    );
    expect(fromB).toBeNull();
    await expect(
      withWorkspace(
        fixtures.b.workspaceId,
        (db) =>
          new ContentLibraryService({
            db,
            workspaceId: fixtures.b.workspaceId,
            policy,
          }).editVariant({
            variantId,
            body: 'x',
            slides: [{ assetId: images[0]!, headline: 'Hijack' }],
            actorUserId: fixtures.b.userId,
            actorBrandScope: [],
            actorPermissionKeys: ['content.edit'],
          }),
        { prisma: app },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
