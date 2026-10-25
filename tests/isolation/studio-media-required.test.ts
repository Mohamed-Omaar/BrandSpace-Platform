import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfigPayload } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  CHANNEL_NEEDS_MEDIA_REASON,
  ContentApprovalService,
  ContentCalendarService,
  parseContentPolicy,
} from '@brandspace/content';
import { captureConfig, type ActivatedConfig } from './config-activation';
import {
  appRoleClient,
  createIsolationFixtures,
  OPEN_CHANNEL_GATE,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * D-569 (Studio review, owner decision 1) — A CHANNEL THAT NEEDS MEDIA NEVER
 * GOES OUT WITHOUT IT. With the channels' capabilities as configured
 * (Instagram accepts no `text` post, TikTok only `video`), sending for review
 * and scheduling refuse a post that lacks the picture or the video, naming the
 * channel and what it needs — and accept it once the media is there. A channel
 * that takes a text post (Facebook) is not held back. Read from the activated
 * `publishing` document (projected), never from code.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let publishing: ActivatedConfig;

const contentPolicy = parseContentPolicy(parseConfigPayload('content', {}));
const FUTURE = `${new Date().getUTCFullYear() + 1}-07-20T09:00`;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  publishing = await captureConfig(platform, 'publishing', { projected: true });
  await publishing.activate({
    providers: {
      facebook: { enabled: true, postKinds: ['text', 'image', 'carousel'] },
      instagram: { enabled: true, postKinds: ['image', 'carousel', 'reel'] },
      tiktok: { enabled: true, postKinds: ['video'] },
    },
  });
}, 90_000);

afterAll(async () => {
  try {
    await publishing?.restore();
  } finally {
    await app?.$disconnect();
    await platform?.$disconnect();
  }
});

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

/** A draft for these channels, each with these kinds of media attached. */
async function post(
  platformKeys: readonly string[],
  media: readonly ('IMAGE' | 'VIDEO')[] = [],
  contentType = 'POST',
): Promise<string> {
  return inA(async (db) => {
    const workspaceId = fixtures.a.workspaceId;
    const brandId = fixtures.a.brandId;
    const assetIds: string[] = [];
    for (const kind of media) {
      const asset = await db.asset.create({
        data: {
          workspaceId,
          brandId,
          name: kind === 'VIDEO' ? 'clip.mp4' : 'photo.png',
          kind,
          mimeType: kind === 'VIDEO' ? 'video/mp4' : 'image/png',
          sizeBytes: 2_048,
          storageKey: `media-required/${randomUUID()}`,
          checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          status: 'READY',
          scanStatus: 'CLEAN',
        } as never,
        select: { id: true },
      });
      assetIds.push(asset.id);
    }
    const item = await db.contentItem.create({
      data: {
        workspaceId,
        brandId,
        title: 'Weekend offer',
        contentType: contentType as never,
        primaryLocale: 'EN',
        status: 'DRAFT',
        origin: 'HUMAN',
        createdByUserId: fixtures.a.userId,
        idempotencyKey: `media-required-${randomUUID()}`,
      },
      select: { id: true },
    });
    for (const platformKey of platformKeys) {
      await db.contentVariant.create({
        data: {
          workspaceId,
          brandId,
          contentItemId: item.id,
          platformKey,
          locale: 'EN',
          body: 'Two lattes for the price of one this weekend.',
          hashtags: [],
          assetIds,
          characterCount: 45,
          validationState: 'VALID',
          origin: 'HUMAN',
        },
      });
    }
    return item.id;
  });
}

const submit = (itemId: string) =>
  inA((db) =>
    new ContentApprovalService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: contentPolicy,
    }).submit({
      itemId,
      actor: {
        userId: fixtures.a.userId,
        roleKey: 'workspace_owner',
        permissionKeys: ['content.submit', 'content.read'],
        brandScope: [],
      },
    }),
  );

const schedule = (itemId: string) =>
  inA((db) =>
    new ContentCalendarService({
      channelGate: OPEN_CHANNEL_GATE,
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: contentPolicy,
      timezone: 'UTC',
      quota: { limit: async () => null, consume: async () => true, refund: async () => undefined },
      approvalGate: { policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }) },
    }).schedule({
      contentItemId: itemId,
      localTime: FUTURE,
      actorUserId: fixtures.a.userId,
      actorBrandScope: [],
    }),
  );

const refusal = (channels: string) => ({
  code: 'CONFLICT',
  publicDetails: { reason: CHANNEL_NEEDS_MEDIA_REASON, channels },
});

const statusOf = async (itemId: string) =>
  (await platform.contentItem.findUniqueOrThrow({ where: { id: itemId } })).status;

describe('D-569 · a channel that needs media is refused without it', () => {
  it('Instagram with no picture: not sent for review, and nothing is written', async () => {
    const itemId = await post(['instagram']);
    await expect(submit(itemId)).rejects.toMatchObject(refusal('instagram:picture'));
    expect(await statusOf(itemId)).toBe('DRAFT');
    expect(await platform.approval.count({ where: { contentItemId: itemId } })).toBe(0);
  });

  it('Instagram with no picture: not scheduled, and no slot is made', async () => {
    const itemId = await post(['instagram']);
    await expect(schedule(itemId)).rejects.toMatchObject(refusal('instagram:picture'));
    expect(await platform.calendarSlot.count({ where: { contentItemId: itemId } })).toBe(0);
  });

  it('TikTok without a video — even with a picture — is refused, naming what it needs', async () => {
    const withPicture = await post(['tiktok'], ['IMAGE']);
    await expect(submit(withPicture)).rejects.toMatchObject(refusal('tiktok:video'));
    const nothing = await post(['tiktok'], [], 'VIDEO');
    await expect(schedule(nothing)).rejects.toMatchObject(refusal('tiktok:video'));
  });

  it('every channel that falls short is named; one that takes text is not', async () => {
    const itemId = await post(['facebook', 'instagram', 'tiktok']);
    await expect(submit(itemId)).rejects.toMatchObject(refusal('instagram:picture,tiktok:video'));
  });

  it('with the media there, it is sent for review and scheduled as before', async () => {
    const instagram = await post(['instagram'], ['IMAGE']);
    await expect(submit(instagram)).resolves.toMatchObject({ status: 'PENDING' });
    const tiktok = await post(['tiktok'], ['VIDEO'], 'VIDEO');
    await expect(schedule(tiktok)).resolves.toBeDefined();
    const text = await post(['facebook']);
    await expect(schedule(text)).resolves.toBeDefined();
  });
});
