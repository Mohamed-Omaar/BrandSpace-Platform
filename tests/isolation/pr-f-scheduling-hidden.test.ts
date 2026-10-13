import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import {
  CHANNELS_NOT_CONNECTABLE_REASON,
  ContentCalendarService,
  type ContentPolicy,
} from '@brandspace/content';
import { unreachableChannelGate } from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import { captureConfig, type ActivatedConfig } from './config-activation';

/**
 * PR F (b), Q8 — WHILE NONE OF A POST'S CHANNELS CAN BE CONNECTED, NOTHING
 * REACHES THE PUBLISHING QUEUE. Against real PostgreSQL, with the channel gate
 * the dashboard, the API, the Copilot and the automations all build, reading
 * the ACTIVATED publishing policy:
 *
 *   - every platform switched off: Schedule and Publish now are refused
 *     (`CHANNELS_NOT_CONNECTABLE`), no slot and no publish job is written, and
 *     "the next free slot" says not schedulable; a proposed time is still kept;
 *   - the post's platform switched on: the same post schedules, with no
 *     release in between.
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
    minLeadMinutes: 15,
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
    maxNoteLength: 1_000,
    maxCyclesPerItem: 25,
  },
};

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let publishing: ActivatedConfig;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  publishing = await captureConfig(platform, 'publishing', { projected: true });
}, 60_000);

afterAll(async () => {
  await publishing?.restore();
  await app?.$disconnect();
  await platform?.$disconnect();
});

const actor = () => ({ actorUserId: fixtures.a.userId, actorBrandScope: [] as string[] });

function inA<T>(fn: (calendar: ContentCalendarService) => Promise<T>): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new ContentCalendarService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: POLICY,
          timezone: 'Asia/Riyadh',
          approvalGate: {
            policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
          },
          quota: { limit: async () => null, consume: async () => true, refund: async () => {} },
          // The gate every app builds, with the environment it reads the policy in.
          channelGate: unreachableChannelGate(db, fixtures.a.workspaceId, 'DEVELOPMENT'),
        }),
      ),
    { prisma: app },
  );
}

async function makeDraft(title: string): Promise<string> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const item = await db.contentItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          title,
          primaryLocale: 'EN',
          status: 'DRAFT',
          createdByUserId: fixtures.a.userId,
        },
      });
      await db.contentVariant.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: 'A caption.',
          characterCount: 10,
          validationState: 'VALID',
        },
      });
      return item.id;
    },
    { prisma: app },
  );
}

let cursor = 0;
function futureLocal(): string {
  cursor += 1;
  const day = new Date(Date.now() + (40 + cursor) * 86_400_000).toISOString().slice(0, 10);
  return `${day}T10:00`;
}

async function reasonOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return (error as { publicDetails?: { reason?: unknown } }).publicDetails?.reason;
  }
  return null;
}

const queued = (itemId: string) =>
  withWorkspace(
    fixtures.a.workspaceId,
    async (db) => ({
      slots: await db.calendarSlot.count({ where: { contentItemId: itemId } }),
      jobs: await db.publishJob.count({ where: { contentItemId: itemId } }),
    }),
    { prisma: app },
  );

describe('PR F (b) · Q8 — no channel can be connected', () => {
  it('Schedule and Publish now are refused, and nothing is queued', async () => {
    await publishing.activate({}); // every platform `enabled: false` (the schema default)
    const itemId = await makeDraft('Q8 refused');
    expect(
      await reasonOf(() =>
        inA((calendar) =>
          calendar.schedule({ contentItemId: itemId, localTime: futureLocal(), ...actor() }),
        ),
      ),
    ).toBe(CHANNELS_NOT_CONNECTABLE_REASON);
    expect(
      await reasonOf(() =>
        inA((calendar) => calendar.publishNow({ contentItemId: itemId, ...actor() })),
      ),
    ).toBe(CHANNELS_NOT_CONNECTABLE_REASON);
    expect(
      await inA((calendar) => calendar.scheduleNextFreeSlot({ contentItemId: itemId, ...actor() })),
    ).toEqual({ kind: 'refused', reason: 'not_schedulable' });
    expect(await queued(itemId)).toEqual({ slots: 0, jobs: 0 });
  });

  it('a proposed time is still kept on the post', async () => {
    await publishing.activate({});
    const itemId = await makeDraft('Q8 proposed');
    const when = futureLocal();
    await inA((calendar) =>
      calendar.propose({ contentItemId: itemId, localTime: when, ...actor() }),
    );
    const item = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.contentItem.findUniqueOrThrow({
          where: { id: itemId },
          select: { proposedLocalTime: true },
        }),
      { prisma: app },
    );
    expect(item.proposedLocalTime).toBe(when);
  });
});

describe('PR F (b) · Q8 — the post’s platform switched on', () => {
  it('the same post schedules, with no release in between', async () => {
    await publishing.activate({ providers: { instagram: { enabled: true } } });
    const itemId = await makeDraft('Q8 allowed');
    await inA((calendar) =>
      calendar.schedule({ contentItemId: itemId, localTime: futureLocal(), ...actor() }),
    );
    expect((await queued(itemId)).slots).toBe(1);
  });
});
