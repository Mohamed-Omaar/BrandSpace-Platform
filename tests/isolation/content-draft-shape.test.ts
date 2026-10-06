import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { ContentLibraryService, type ContentPolicy } from '@brandspace/content';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * ROUND 5 (B, D-478) — A DRAFT'S FORMAT AND CHANNELS, against a real
 * PostgreSQL under RLS.
 *
 * `changeDraftShape` is a new way to write a tenant's post, so it gets its own
 * isolation proof: another workspace and a member outside the brand scope
 * get the same not-found a miss gives, and nothing moves. Every test makes
 * its OWN post so the shared fixture item is never touched.
 */

const CONTENT_POLICY: ContentPolicy = {
  dialects: {
    defaultKey: 'msa',
    supported: [{ key: 'msa', labelKey: 'content.dialect.msa', bcp47: 'ar' }],
  },
  platforms: [
    {
      key: 'instagram',
      labelKey: 'content.platform.instagram',
      maxBodyChars: 2_200,
      maxHashtags: 30,
      allowsFirstComment: true,
      maxMediaItems: 10,
    },
    {
      key: 'linkedin',
      labelKey: 'content.platform.linkedin',
      maxBodyChars: 3_000,
      maxHashtags: 10,
      allowsFirstComment: false,
      maxMediaItems: 10,
    },
  ],
  generation: {
    maxVariantsPerRequest: 4,
    maxDraftsPerBrand: 500,
    maxContextItems: 12,
    maxContextChunks: 8,
    maxContextChars: 12_000,
    maxBriefChars: 2_000,
  },
  retention: { cancellationGraceDays: 30, minCustomerRetentionDays: 7 },
  calendar: {
    weekStartsOn: 0,
    maxDaysAhead: 365,
    minLeadMinutes: 5,
    maxSlotsPerDay: 25,
    requireApprovalBeforeScheduling: false,
  },
  learning: {
    preferenceMinObservations: 4,
    preferenceMinPosts: 3,
    workflowMinRepeats: 4,
    windowDays: 90,
    snoozeDays: 30,
  },
  approvals: {
    requireApprovalBeforeScheduling: false,
    allowSelfApproval: false,
    clientApprovalEnabled: false,
    maxNoteLength: 400,
    maxCyclesPerItem: 5,
  },
};

let fixtures: IsolationFixtures;
let app: PrismaClient;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

function inWorkspace<T>(
  workspaceId: string,
  fn: (library: ContentLibraryService, db: TenantScopedClient) => Promise<T>,
): Promise<T> {
  return withWorkspace(
    workspaceId,
    (db) => fn(new ContentLibraryService({ db, workspaceId, policy: CONTENT_POLICY }), db),
    { prisma: app },
  );
}
const inA = <T>(fn: (library: ContentLibraryService, db: TenantScopedClient) => Promise<T>) =>
  inWorkspace(fixtures.a.workspaceId, fn);

/** A fresh one-channel POST draft on brand A. */
async function freshDraft(): Promise<string> {
  return inA(async (library) => {
    const created = await library.createManualItem({
      brandId: fixtures.a.brandId,
      title: 'Shape test',
      locale: 'EN',
      variants: [{ platformKey: 'instagram', body: 'Words to carry over.', hashtags: ['kunafa'] }],
      actorUserId: fixtures.a.userId,
      actorBrandScope: [],
      expiresAt: null,
      idempotencyKey: `shape-${crypto.randomUUID()}`,
    });
    return created.item.id;
  });
}

async function shapeOf(itemId: string) {
  return inA(async (_library, db) => {
    const item = await db.contentItem.findUniqueOrThrow({ where: { id: itemId } });
    const variants = await db.contentVariant.findMany({
      where: { contentItemId: itemId },
      orderBy: { platformKey: 'asc' },
    });
    const audits = await db.auditEvent.count({
      where: { resourceId: itemId, action: 'content.item.reshaped' },
    });
    return {
      contentType: item.contentType,
      channels: variants.map((variant) => variant.platformKey),
      bodies: variants.map((variant) => variant.body),
      hashtags: variants.map((variant) => variant.hashtags),
      audits,
    };
  });
}

const change = (
  itemId: string,
  contentType: 'POST' | 'CAROUSEL' | 'REEL',
  platformKeys: string[],
  extra: { carriers?: string[] | null; scope?: string[] } = {},
) =>
  inA((library) =>
    library.changeDraftShape({
      itemId,
      contentType,
      platformKeys,
      carriers: extra.carriers ?? null,
      actorUserId: fixtures.a.userId,
      actorBrandScope: extra.scope ?? [],
    }),
  );

describe("D-478 · a draft's format and channels change while it is a draft", () => {
  it("changes the format, adds a channel from a kept version's words, and audits it", async () => {
    const itemId = await freshDraft();
    const result = await change(itemId, 'CAROUSEL', ['instagram', 'linkedin']);
    expect(result.added).toEqual(['linkedin']);
    expect(result.removed).toEqual([]);
    const after = await shapeOf(itemId);
    expect(after.contentType).toBe('CAROUSEL');
    expect(after.channels).toEqual(['instagram', 'linkedin']);
    expect(after.bodies).toEqual(['Words to carry over.', 'Words to carry over.']);
    expect(after.hashtags).toEqual([['kunafa'], ['kunafa']]);
    expect(after.audits).toBe(1);
  });

  it('removes a channel, and a request that changes nothing writes nothing', async () => {
    const itemId = await freshDraft();
    await change(itemId, 'POST', ['instagram', 'linkedin']);
    const removed = await change(itemId, 'POST', ['linkedin']);
    expect(removed.removed).toEqual(['instagram']);
    expect((await shapeOf(itemId)).channels).toEqual(['linkedin']);
    const audits = (await shapeOf(itemId)).audits;
    await change(itemId, 'POST', ['linkedin']);
    expect((await shapeOf(itemId)).audits).toBe(audits);
  });

  it('works while changes are requested, and is refused once the post is in review', async () => {
    const itemId = await freshDraft();
    await inA((_library, db) =>
      db.contentItem.update({ where: { id: itemId }, data: { status: 'CHANGES_REQUESTED' } }),
    );
    await change(itemId, 'REEL', ['instagram']);
    expect((await shapeOf(itemId)).contentType).toBe('REEL');

    await inA((_library, db) =>
      db.contentItem.update({ where: { id: itemId }, data: { status: 'IN_REVIEW' } }),
    );
    await expect(change(itemId, 'POST', ['instagram', 'linkedin'])).rejects.toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: 'shape_locked' },
    });
    const after = await shapeOf(itemId);
    expect(after.contentType).toBe('REEL');
    expect(after.channels).toEqual(['instagram']);
  });

  it('names a channel that cannot carry the format, and changes nothing', async () => {
    const itemId = await freshDraft();
    await expect(
      change(itemId, 'REEL', ['instagram', 'linkedin'], { carriers: ['instagram'] }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      publicDetails: { reason: 'format_not_carried', platformKeys: 'linkedin' },
    });
    const after = await shapeOf(itemId);
    expect(after.contentType).toBe('POST');
    expect(after.channels).toEqual(['instagram']);
  });

  it('refuses no channel, an unknown channel and a repeated one', async () => {
    const itemId = await freshDraft();
    for (const keys of [[], ['myspace'], ['instagram', 'instagram']]) {
      await expect(change(itemId, 'POST', keys)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    expect((await shapeOf(itemId)).channels).toEqual(['instagram']);
  });
});

describe('D-478 · tenant isolation', () => {
  it('another workspace cannot change, or learn of, a post in this one', async () => {
    const itemId = await freshDraft();
    await expect(
      inWorkspace(fixtures.b.workspaceId, (library) =>
        library.changeDraftShape({
          itemId,
          contentType: 'REEL',
          platformKeys: ['instagram', 'linkedin'],
          carriers: null,
          actorUserId: fixtures.b.userId,
          actorBrandScope: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Content not found.' });
    const after = await shapeOf(itemId);
    expect(after.contentType).toBe('POST');
    expect(after.channels).toEqual(['instagram']);
    expect(after.audits).toBe(0);
  });

  it('a member outside the brand scope gets the same not-found, and nothing moves', async () => {
    const itemId = await freshDraft();
    await expect(
      change(itemId, 'REEL', ['instagram'], { scope: [crypto.randomUUID()] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Content not found.' });
    expect((await shapeOf(itemId)).contentType).toBe('POST');
  });

  it('an id that does not exist is the same not-found', async () => {
    await expect(change(crypto.randomUUID(), 'POST', ['instagram'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Content not found.',
    });
  });
});
