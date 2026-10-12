import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { CampaignService, ContentLibraryService, type ContentPolicy } from '@brandspace/content';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * FIX PR 2c (D-506), AGAINST REAL POSTGRESQL THROUGH THE TENANT ROLE.
 *
 * B2.3 — DUPLICATE WITH A LAPSED LICENCE. A post whose file's licence has
 * ended is copied WITHOUT that file, and the file is named in `mediaLeftOut`;
 * before, the copy re-checked its media and the whole duplicate failed with
 * "Asset not found". A file whose licence is still running is copied. The
 * lapsed files are read inside the caller's workspace only: another
 * workspace's post cannot be duplicated, and is the ordinary "not found".
 *
 * Campaign Pause — the card's Pause is the existing `CampaignService.pause`,
 * audited with reason `manual_pause` (the automation's own keeps
 * `automation_pause`); another workspace's campaign stays unavailable.
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

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const inWorkspace = <T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(workspaceId, fn as never, { prisma: app }) as Promise<T>;
const library = (db: TenantScopedClient, workspaceId: string) =>
  new ContentLibraryService({ db, workspaceId, policy: CONTENT_POLICY });

async function asset(rightsExpiryAt: Date | null): Promise<string> {
  return (
    await platform.asset.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        name: `fix2c-${randomUUID().slice(0, 6)}.png`,
        kind: 'IMAGE',
        mimeType: 'image/png',
        sizeBytes: 2_048,
        storageKey: `fix2c/${randomUUID()}`,
        checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        status: 'READY',
        scanStatus: 'CLEAN',
        ...(rightsExpiryAt ? { license: 'Stock licence', rightsExpiryAt } : {}),
      } as never,
      select: { id: true },
    })
  ).id;
}

const duplicate = (workspaceId: string, sourceItemId: string) =>
  inWorkspace(workspaceId, (db) =>
    library(db, workspaceId).duplicateItem({
      sourceItemId,
      actorUserId: workspaceId === fixtures.a.workspaceId ? fixtures.a.userId : fixtures.b.userId,
      actorBrandScope: [],
      actorPermissionKeys: ['content.create'],
      expiresAt: null,
      idempotencyKey: `fix2c-dup-${randomUUID()}`,
    }),
  );

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('B2.3 — a duplicate leaves out the files whose licence has ended', () => {
  let sourceId: string;
  let lapsing: string;
  let running: string;

  beforeAll(async () => {
    // Both licences are running when the post is made, as they were for the customer.
    lapsing = await asset(new Date(Date.now() + 86_400_000));
    running = await asset(new Date(Date.now() + 365 * 86_400_000));
    const created = await inWorkspace(fixtures.a.workspaceId, (db) =>
      library(db, fixtures.a.workspaceId).createManualItem({
        brandId: fixtures.a.brandId,
        title: 'Two pictures',
        contentType: 'CAROUSEL',
        locale: 'EN',
        variants: [{ platformKey: 'instagram', body: 'Words', assetIds: [lapsing, running] }],
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        expiresAt: null,
        idempotencyKey: `fix2c-src-${randomUUID()}`,
      }),
    );
    sourceId = created.item.id;
    // Then one licence ends.
    await platform.asset.update({
      where: { id: lapsing },
      data: { rightsExpiryAt: new Date(Date.now() - 60_000) },
    });
  });

  it('copies the post with the running file only, and names the one left out', async () => {
    const copy = await duplicate(fixtures.a.workspaceId, sourceId);
    expect(copy.mediaLeftOut).toEqual([lapsing]);
    expect(copy.item.id).not.toBe(sourceId);
    expect(copy.variants.map((variant) => variant.assetIds)).toEqual([[running]]);
    // The source keeps both.
    const source = await platform.contentVariant.findFirstOrThrow({
      where: { contentItemId: sourceId },
      select: { assetIds: true },
    });
    expect(source.assetIds).toEqual([lapsing, running]);
  });

  it('leaves nothing out when every licence is running', async () => {
    const fine = await asset(null);
    const created = await inWorkspace(fixtures.a.workspaceId, (db) =>
      library(db, fixtures.a.workspaceId).createManualItem({
        brandId: fixtures.a.brandId,
        title: 'One picture',
        locale: 'EN',
        variants: [{ platformKey: 'instagram', body: 'Words', assetIds: [fine] }],
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        expiresAt: null,
        idempotencyKey: `fix2c-src-${randomUUID()}`,
      }),
    );
    const copy = await duplicate(fixtures.a.workspaceId, created.item.id);
    expect(copy.mediaLeftOut).toEqual([]);
    expect(copy.variants.map((variant) => variant.assetIds)).toEqual([[fine]]);
  });

  it("another workspace cannot duplicate A's post: the ordinary not found", async () => {
    await expect(duplicate(fixtures.b.workspaceId, sourceId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(duplicate(fixtures.b.workspaceId, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('Campaign Pause on the card — audited as a person pausing', () => {
  async function campaign(workspaceId: string, brandId: string, userId: string) {
    return (
      await platform.campaign.create({
        data: {
          workspaceId,
          brandId,
          name: `Fix 2c ${randomUUID().slice(0, 6)}`,
          objective: 'AWARENESS',
          status: 'ACTIVE',
          createdByUserId: userId,
        },
        select: { id: true },
      })
    ).id;
  }
  const pause = (campaignId: string, brandId: string) =>
    inWorkspace(fixtures.a.workspaceId, (db) =>
      new CampaignService({ db: db as never, workspaceId: fixtures.a.workspaceId }).pause({
        campaignId,
        brandId,
        actor: { userId: fixtures.a.userId, brandScope: [] },
        reason: 'manual_pause',
      }),
    );

  it('pauses, and the audit event says manual_pause', async () => {
    const id = await campaign(fixtures.a.workspaceId, fixtures.a.brandId, fixtures.a.userId);
    expect(await pause(id, fixtures.a.brandId)).toMatchObject({
      kind: 'paused',
      campaign: { status: 'PAUSED' },
    });
    const audit = await platform.auditEvent.findFirstOrThrow({
      where: { action: 'campaign.updated', resourceId: id },
    });
    expect(audit).toMatchObject({ actorId: fixtures.a.userId, reason: 'manual_pause' });
  });

  it("another workspace's campaign is unavailable and does not change", async () => {
    const id = await campaign(fixtures.b.workspaceId, fixtures.b.brandId, fixtures.b.userId);
    expect(await pause(id, fixtures.b.brandId)).toEqual({
      kind: 'refused',
      reason: 'campaign_unavailable',
    });
    const row = await platform.campaign.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ACTIVE');
  });
});
