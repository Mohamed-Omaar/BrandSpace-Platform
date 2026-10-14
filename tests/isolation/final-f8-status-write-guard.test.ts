import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  CONTENT_MOVED_SINCE_REASON,
  ContentLibraryService,
  type ContentPolicy,
} from '@brandspace/content';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * F8 (FINAL REVIEW) — A STATUS CHANGE IS WRITTEN ONLY OVER THE STATUS IT WAS
 * DECIDED ON.
 *
 * `transition` (archive, restore) and the approval revoke an edit makes read
 * the post's status, decide, then wrote unconditionally. A change committed in
 * between — the post scheduled by somebody else — was overwritten: an approved
 * post scheduled meanwhile was archived, or turned back into a draft, under
 * its live slot. Both writes are now conditional on the status that was read,
 * so the second request is refused and the post keeps what the first did.
 *
 * The race is made deterministic: the tenant client is wrapped so that, right
 * after the service has read the post, another connection (the platform role)
 * commits the concurrent change.
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
let platform: PrismaClient;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

/**
 * The tenant client, with one interference: the first `contentItem` read that
 * `pick` recognises is followed, before the service sees its result, by
 * `change` committed on a separate connection.
 */
function interfering(
  db: TenantScopedClient,
  pick: (method: string, args: unknown) => boolean,
  change: () => Promise<unknown>,
): TenantScopedClient {
  let done = false;
  const items = new Proxy(db.contentItem, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return async (args: unknown) => {
        const result = await (value as (a: unknown) => Promise<unknown>).call(target, args);
        if (!done && pick(String(property), args)) {
          done = true;
          await change();
        }
        return result;
      };
    },
  });
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'contentItem') return items;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

const library = (db: TenantScopedClient) =>
  new ContentLibraryService({ db, workspaceId: fixtures.a.workspaceId, policy: CONTENT_POLICY });

async function approvedPost(): Promise<{ itemId: string; variantId: string }> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const created = await library(db).createManualItem({
        brandId: fixtures.a.brandId,
        title: 'Raced post',
        locale: 'EN',
        variants: [{ platformKey: 'instagram', body: 'Approved words.' }],
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        expiresAt: null,
        idempotencyKey: `f8-${crypto.randomUUID()}`,
      });
      await db.contentItem.update({
        where: { id: created.item.id },
        data: { status: 'APPROVED' },
      });
      return { itemId: created.item.id, variantId: created.variants[0]?.id ?? '' };
    },
    { prisma: app },
  );
}

const scheduledMeanwhile = (itemId: string) => () =>
  platform.contentItem.update({ where: { id: itemId }, data: { status: 'SCHEDULED' } });

const statusOf = async (itemId: string) =>
  (await platform.contentItem.findUniqueOrThrow({ where: { id: itemId } })).status;

describe('F8 · a status write never overwrites a change made since it was read', () => {
  it('archiving an approved post that was scheduled meanwhile is refused; it stays scheduled', async () => {
    const post = await approvedPost();
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        (db) =>
          library(
            interfering(db, (method) => method === 'findFirst', scheduledMeanwhile(post.itemId)),
          ).transition({
            itemId: post.itemId,
            to: 'ARCHIVED',
            actorUserId: fixtures.a.userId,
            actorBrandScope: [],
            actorPermissionKeys: ['content.archive', 'content.edit'],
          }),
        { prisma: app },
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: CONTENT_MOVED_SINCE_REASON },
    });
    expect(await statusOf(post.itemId)).toBe('SCHEDULED');
  });

  it('without a concurrent change the same archive still goes through', async () => {
    const post = await approvedPost();
    const moved = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        library(db).transition({
          itemId: post.itemId,
          to: 'ARCHIVED',
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
          actorPermissionKeys: ['content.archive', 'content.edit'],
        }),
      { prisma: app },
    );
    expect(moved.status).toBe('ARCHIVED');
  });

  it("an edit's approval revoke does not turn a post scheduled meanwhile back into a draft", async () => {
    const post = await approvedPost();
    // The revoke's own read selects the id and the status.
    const revokeRead = (method: string, args: unknown) =>
      method === 'findUnique' &&
      typeof args === 'object' &&
      args !== null &&
      'select' in args &&
      JSON.stringify((args as { select: unknown }).select) === '{"id":true,"status":true}';
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        (db) =>
          library(interfering(db, revokeRead, scheduledMeanwhile(post.itemId))).editVariant({
            variantId: post.variantId,
            body: 'Edited while somebody scheduled it.',
            actorUserId: fixtures.a.userId,
            actorBrandScope: [],
            actorPermissionKeys: ['content.edit', 'content.schedule'],
          }),
        { prisma: app },
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: CONTENT_MOVED_SINCE_REASON },
    });
    expect(await statusOf(post.itemId)).toBe('SCHEDULED');
    expect(
      (await platform.contentVariant.findUniqueOrThrow({ where: { id: post.variantId } })).body,
    ).toBe('Approved words.');
  });
});
