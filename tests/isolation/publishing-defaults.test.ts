import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { ContentLibraryService, type ContentPolicy } from '@brandspace/content';
import {
  saveBrandAiSuggestions,
  savePublishingDefaults,
} from '../../apps/dashboard/src/server/publishing-defaults';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * SETTINGS → PUBLISHING DEFAULTS AND THE AI SUGGESTIONS SWITCH (A8 / A10 / D7,
 * Phase 2B-2) AGAINST REAL POSTGRESQL.
 *
 * The defaults are columns on the brand, so RLS keeps them inside the
 * workspace; the writers add the member's BrandScope, refuse a channel the
 * policy does not offer, and audit what changed. "Hashtags in the first
 * comment" is applied when a post is created, only on a channel that takes a
 * first comment.
 */

const POLICY: ContentPolicy = {
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
      key: 'x',
      labelKey: 'content.platform.x',
      maxBodyChars: 280,
      maxHashtags: 5,
      allowsFirstComment: false,
      maxMediaItems: 4,
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

function inWs<T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(workspaceId, fn, { prisma: app });
}

const contextA = (brandScope: readonly string[] = []) => ({
  workspaceId: fixtures.a.workspaceId,
  actorUserId: fixtures.a.userId,
  brandScope,
  knownPlatformKeys: POLICY.platforms.map((p) => p.key),
});

describe('publishing defaults', () => {
  it('saves the channels, time and first-comment switch, and audits what changed', async () => {
    await inWs(fixtures.a.workspaceId, (db) =>
      savePublishingDefaults(db, contextA(), {
        brandId: fixtures.a.brandId,
        platformKeys: ['instagram', 'x', 'instagram'],
        defaultPostTime: '10:30',
        hashtagsInFirstComment: true,
      }),
    );
    const brand = await platform.brand.findUniqueOrThrow({
      where: { id: fixtures.a.brandId },
      select: { defaultPlatformKeys: true, defaultPostTime: true, hashtagsInFirstComment: true },
    });
    expect(brand).toEqual({
      defaultPlatformKeys: ['instagram', 'x'],
      defaultPostTime: '10:30',
      hashtagsInFirstComment: true,
    });
    expect(
      await platform.auditEvent.count({
        where: {
          workspaceId: fixtures.a.workspaceId,
          action: 'brand.publishing_defaults.updated',
          resourceId: fixtures.a.brandId,
        },
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('refuses a channel the policy does not offer, and a time that is not a time', async () => {
    await expect(
      inWs(fixtures.a.workspaceId, (db) =>
        savePublishingDefaults(db, contextA(), {
          brandId: fixtures.a.brandId,
          platformKeys: ['myspace'],
          defaultPostTime: '',
          hashtagsInFirstComment: false,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      inWs(fixtures.a.workspaceId, (db) =>
        savePublishingDefaults(db, contextA(), {
          brandId: fixtures.a.brandId,
          platformKeys: [],
          defaultPostTime: '25:00',
          hashtagsInFirstComment: false,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('the database refuses a malformed time even if a writer forgot to check', async () => {
    await expect(
      platform.brand.update({
        where: { id: fixtures.a.brandId },
        data: { defaultPostTime: '9am' },
      }),
    ).rejects.toThrow();
  });

  it('never reaches another workspace, or a brand outside the member scope', async () => {
    await expect(
      inWs(fixtures.b.workspaceId, (db) =>
        savePublishingDefaults(
          db,
          { ...contextA(), workspaceId: fixtures.b.workspaceId },
          {
            brandId: fixtures.a.brandId,
            platformKeys: [],
            defaultPostTime: '08:00',
            hashtagsInFirstComment: false,
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      inWs(fixtures.a.workspaceId, (db) =>
        savePublishingDefaults(db, contextA([crypto.randomUUID()]), {
          brandId: fixtures.a.brandId,
          platformKeys: [],
          defaultPostTime: '08:00',
          hashtagsInFirstComment: false,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const brand = await platform.brand.findUniqueOrThrow({
      where: { id: fixtures.a.brandId },
      select: { defaultPostTime: true },
    });
    expect(brand.defaultPostTime).not.toBe('08:00');
  });

  it('a new post of a brand with the switch on carries its hashtags in the first comment, where the channel takes one', async () => {
    await inWs(fixtures.a.workspaceId, (db) =>
      savePublishingDefaults(db, contextA(), {
        brandId: fixtures.a.brandId,
        platformKeys: ['instagram'],
        defaultPostTime: '',
        hashtagsInFirstComment: true,
      }),
    );
    const created = await inWs(fixtures.a.workspaceId, (db) =>
      new ContentLibraryService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: POLICY,
      }).createManualItem({
        brandId: fixtures.a.brandId,
        title: 'Tags below',
        locale: 'EN',
        variants: [
          { platformKey: 'instagram', body: 'Words', hashtags: ['spring', 'launch'] },
          { platformKey: 'x', body: 'Words', hashtags: ['spring'] },
        ],
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        expiresAt: null,
        idempotencyKey: `pd-${crypto.randomUUID()}`,
      }),
    );
    const byPlatform = Object.fromEntries(created.variants.map((v) => [v.platformKey, v]));
    expect(byPlatform['instagram']).toMatchObject({
      hashtags: [],
      firstComment: '#spring #launch',
    });
    expect(byPlatform['x']).toMatchObject({ hashtags: ['spring'], firstComment: null });
  });
});

describe('AI suggestions on/off (D7)', () => {
  it('switches the brand, audits it, and never reaches another workspace', async () => {
    const context = {
      workspaceId: fixtures.a.workspaceId,
      actorUserId: fixtures.a.userId,
      brandScope: [],
    };
    await inWs(fixtures.a.workspaceId, (db) =>
      saveBrandAiSuggestions(db, context, { brandId: fixtures.a.brandId, enabled: false }),
    );
    expect(
      (
        await platform.brand.findUniqueOrThrow({
          where: { id: fixtures.a.brandId },
          select: { aiSuggestionsEnabled: true },
        })
      ).aiSuggestionsEnabled,
    ).toBe(false);
    expect(
      await platform.auditEvent.count({
        where: { action: 'brand.ai_suggestions.changed', resourceId: fixtures.a.brandId },
      }),
    ).toBe(1);

    await expect(
      inWs(fixtures.b.workspaceId, (db) =>
        saveBrandAiSuggestions(
          db,
          { ...context, workspaceId: fixtures.b.workspaceId },
          { brandId: fixtures.a.brandId, enabled: true },
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (
        await platform.brand.findUniqueOrThrow({
          where: { id: fixtures.a.brandId },
          select: { aiSuggestionsEnabled: true },
        })
      ).aiSuggestionsEnabled,
    ).toBe(false);
  });
});
