import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiGateway } from '@brandspace/ai-gateway';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import type { READ_ONLY_CONTENT_STATUSES } from '@brandspace/content';
import {
  ContentLibraryService,
  ContentStudioService,
  type ContentPolicy,
} from '@brandspace/content';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Prototype v76 alignment, Phase 1 — the content editing guards, against a
 * real PostgreSQL under RLS.
 *
 * Every test makes its OWN post through the ordinary manual-create path, so the
 * shared fixture item other suites rely on is never moved.
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

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

function inA<T>(fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });
}

function library(db: TenantScopedClient): ContentLibraryService {
  return new ContentLibraryService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: CONTENT_POLICY,
  });
}

/** A fresh one-variant post on brand A. */
async function freshPost(): Promise<{ itemId: string; variantId: string }> {
  return inA(async (db) => {
    const created = await library(db).createManualItem({
      brandId: fixtures.a.brandId,
      title: 'Guarded post',
      locale: 'EN',
      variants: [{ platformKey: 'instagram', body: 'The words that went out.' }],
      actorUserId: fixtures.a.userId,
      actorBrandScope: [],
      expiresAt: null,
      idempotencyKey: `guard-${crypto.randomUUID()}`,
    });
    const variant = created.variants[0];
    if (!variant) throw new Error('the fixture post has no variant');
    return { itemId: created.item.id, variantId: variant.id };
  });
}

async function setStatus(itemId: string, status: string): Promise<void> {
  await inA((db) =>
    db.contentItem.update({
      where: { id: itemId },
      data: { status: status as (typeof READ_ONLY_CONTENT_STATUSES)[number] },
    }),
  );
}

async function bodyOf(variantId: string): Promise<string | null> {
  return inA(
    async (db) => (await db.contentVariant.findUniqueOrThrow({ where: { id: variantId } })).body,
  );
}

describe('B-2 · a published post is read-only', () => {
  it.each(['PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED'])(
    'refuses a manual edit while the post is %s, and changes nothing',
    async (status) => {
      const post = await freshPost();
      await setStatus(post.itemId, status);

      await expect(
        inA((db) =>
          library(db).editVariant({
            variantId: post.variantId,
            body: 'Rewritten after the fact.',
            actorUserId: fixtures.a.userId,
            actorBrandScope: [],
          }),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await bodyOf(post.variantId)).toBe('The words that went out.');
    },
  );

  it('refuses an AI edit BEFORE the model is called, so no credit is spent', async () => {
    const post = await freshPost();
    await setStatus(post.itemId, 'PUBLISHED');
    let calls = 0;
    const gateway = {
      execute: () => {
        calls += 1;
        throw new Error('the gateway must not be reached for a published post');
      },
    } as unknown as AiGateway;

    await expect(
      inA((db) =>
        new ContentStudioService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          gateway,
        }).applyTool({
          variantId: post.variantId,
          tool: 'shorten',
          idempotencyKey: `tool-${crypto.randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(calls).toBe(0);
    expect(await bodyOf(post.variantId)).toBe('The words that went out.');
  });

  it('still lets a draft, and a failed post, be edited', async () => {
    for (const status of ['DRAFT', 'FAILED']) {
      const post = await freshPost();
      await setStatus(post.itemId, status);
      await inA((db) =>
        library(db).editVariant({
          variantId: post.variantId,
          body: `Edited while ${status}.`,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
        }),
      );
      expect(await bodyOf(post.variantId)).toBe(`Edited while ${status}.`);
    }
  });
});
