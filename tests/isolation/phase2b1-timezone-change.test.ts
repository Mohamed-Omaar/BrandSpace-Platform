import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfigPayload } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { NOTIFICATION_CATEGORIES, NotificationPreferenceService } from '@brandspace/notifications';
import {
  ContentCalendarService,
  WorkspaceTimezoneService,
  parseContentPolicy,
  scheduleUsageKey,
  timezoneChangeEffects,
} from '@brandspace/content';
import { appRoleClient, platformRoleClient, OPEN_CHANNEL_GATE } from './fixtures';

/**
 * PROTOTYPE v94 PHASE 2B-1, ITEM 7 — G5 / Q22: A TIME-ZONE CHANGE KEEPS EVERY
 * PLANNED POST AT ITS LOCAL CLOCK TIME (D-334), AGAINST REAL POSTGRESQL.
 *
 * Tuesday 09:00 stays Tuesday 09:00, in the new zone. A post that would then
 * be in the past (or too soon) goes back to PLANNED with its quota refunded and
 * its author told — never published late or dropped. Posts already publishing
 * are history and do not move; another workspace's posts are never touched.
 */

let app: PrismaClient;
let platform: PrismaClient;
const POLICY = parseContentPolicy(parseConfigPayload('content', {}));
const NOW = new Date(Date.UTC(2026, 9, 1, 12, 0));
const clock = { now: () => NOW };

beforeAll(() => {
  app = appRoleClient();
  platform = platformRoleClient();
});

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

async function world(timezone: string) {
  const id = randomUUID();
  const author = await platform.user.create({
    data: {
      email: `p2b1-tz-${id.slice(0, 8)}@example.local`,
      name: 'Author',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
    select: { id: true },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `p2b1-tz-${id.slice(0, 12)}`,
      name: 'Time zone',
      ownerUserId: author.id,
      status: 'ACTIVE',
      country: 'US',
      defaultLocale: 'EN',
      timezone,
      currency: 'USD',
    },
  });
  const brand = await platform.brand.create({
    data: { workspaceId: id, slug: `tz-${id.slice(0, 8)}`, name: 'TZ', status: 'ACTIVE' },
    select: { id: true },
  });
  return { workspaceId: id, brandId: brand.id, authorId: author.id };
}

async function slot(
  w: Awaited<ReturnType<typeof world>>,
  localTime: string,
  atUtc: Date,
  status: 'SCHEDULED' | 'PUBLISHING' = 'SCHEDULED',
) {
  const item = await platform.contentItem.create({
    data: {
      workspaceId: w.workspaceId,
      brandId: w.brandId,
      title: `Post at ${localTime}`,
      contentType: 'POST',
      primaryLocale: 'EN',
      status: status === 'PUBLISHING' ? 'PUBLISHING' : 'SCHEDULED',
      origin: 'HUMAN',
      createdByUserId: w.authorId,
      idempotencyKey: `tz-${randomUUID()}`,
    },
    select: { id: true },
  });
  await platform.contentVariant.create({
    data: {
      workspaceId: w.workspaceId,
      brandId: w.brandId,
      contentItemId: item.id,
      platformKey: 'linkedin',
      locale: 'EN',
      body: 'Body',
      hashtags: [],
      characterCount: 4,
      validationState: 'VALID',
      origin: 'HUMAN',
    },
  });
  const created = await platform.calendarSlot.create({
    data: {
      workspaceId: w.workspaceId,
      brandId: w.brandId,
      contentItemId: item.id,
      scheduledAtUtc: atUtc,
      scheduledLocalTime: localTime,
      timezone: 'UTC',
      status,
      platformKeys: ['linkedin'],
      createdByUserId: w.authorId,
      usageIdempotencyKey: `calendar:${w.workspaceId}:${randomUUID()}`,
    },
    select: { id: true, usageIdempotencyKey: true },
  });
  return { slotId: created.id, itemId: item.id, usageKey: created.usageIdempotencyKey! };
}

function inTenant<T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(workspaceId, fn, { prisma: app });
}

describe('G5 / Q22 · the local clock time is kept', () => {
  it('Tuesday 09:00 UTC becomes Tuesday 09:00 in Riyadh; audited; the zone changes with it', async () => {
    const w = await world('UTC');
    const later = await slot(w, '2026-12-01T09:00', new Date(Date.UTC(2026, 11, 1, 9, 0)));
    const refunds: string[] = [];
    const result = await inTenant(w.workspaceId, (db) =>
      new WorkspaceTimezoneService({
        db,
        workspaceId: w.workspaceId,
        quota: { refund: async (key) => void refunds.push(key) },
        clock,
      }).change({
        toZone: 'Asia/Riyadh',
        actor: { type: 'USER', id: w.authorId },
        minLeadMinutes: POLICY.calendar.minLeadMinutes,
      }),
    );
    expect(result.from).toBe('UTC');
    const moved = await platform.calendarSlot.findUniqueOrThrow({ where: { id: later.slotId } });
    expect(moved).toMatchObject({
      status: 'SCHEDULED',
      scheduledLocalTime: '2026-12-01T09:00',
      timezone: 'Asia/Riyadh',
    });
    expect(moved.scheduledAtUtc.toISOString()).toBe('2026-12-01T06:00:00.000Z');
    expect(refunds).toEqual([]);
    expect(
      (await platform.workspace.findUniqueOrThrow({ where: { id: w.workspaceId } })).timezone,
    ).toBe('Asia/Riyadh');
    const audits = await platform.auditEvent.findMany({
      where: {
        workspaceId: w.workspaceId,
        action: { in: ['content.rescheduled', 'workspace.timezone.changed'] },
      },
      select: { action: true },
    });
    expect(audits.map((a) => a.action).sort()).toEqual([
      'content.rescheduled',
      'workspace.timezone.changed',
    ]);
  });

  it('a post that would then be in the past goes back to PLANNED, refunded, its author told; publishing posts do not move', async () => {
    const w = await world('UTC');
    // 14:00 UTC today is two hours from now; 14:00 in Tokyo (UTC+9) is 05:00 UTC — past.
    const soon = await slot(w, '2026-10-01T14:00', new Date(Date.UTC(2026, 9, 1, 14, 0)));
    const going = await slot(
      w,
      '2026-10-01T15:00',
      new Date(Date.UTC(2026, 9, 1, 15, 0)),
      'PUBLISHING',
    );
    const refunds: string[] = [];

    const preview = await inTenant(w.workspaceId, (db) =>
      timezoneChangeEffects(db, {
        workspaceId: w.workspaceId,
        toZone: 'Asia/Tokyo',
        now: NOW,
        minLeadMinutes: POLICY.calendar.minLeadMinutes,
      }),
    );
    expect(preview.map((effect) => [effect.slotId, effect.outcome])).toEqual([
      [soon.slotId, 'unplanned'],
    ]);

    await inTenant(w.workspaceId, (db) =>
      new WorkspaceTimezoneService({
        db,
        workspaceId: w.workspaceId,
        quota: { refund: async (key) => void refunds.push(key) },
        clock,
      }).change({
        toZone: 'Asia/Tokyo',
        actor: { type: 'USER', id: w.authorId },
        minLeadMinutes: POLICY.calendar.minLeadMinutes,
      }),
    );
    expect(
      await platform.calendarSlot.findUniqueOrThrow({ where: { id: soon.slotId } }),
    ).toMatchObject({
      status: 'PLANNED',
      timezone: 'Asia/Tokyo',
      scheduledLocalTime: '2026-10-01T14:00',
    });
    expect(refunds).toEqual([`${soon.usageKey}:refund`]);
    expect(
      (await platform.contentItem.findUniqueOrThrow({ where: { id: soon.itemId } })).status,
    ).toBe('DRAFT');
    const told = await platform.notification.findMany({
      where: { workspaceId: w.workspaceId, userId: w.authorId },
      select: { templateKey: true, resourceId: true },
    });
    expect(told).toEqual([
      { templateKey: 'calendar.unplanned_by_timezone_change', resourceId: soon.slotId },
    ]);
    // History does not move.
    expect(
      await platform.calendarSlot.findUniqueOrThrow({ where: { id: going.slotId } }),
    ).toMatchObject({ status: 'PUBLISHING', timezone: 'UTC' });
  });

  it('review item 17 · its author is told even with every notification switch off', async () => {
    const w = await world('UTC');
    const soon = await slot(w, '2026-10-01T14:00', new Date(Date.UTC(2026, 9, 1, 14, 0)));
    await inTenant(w.workspaceId, (db) =>
      new NotificationPreferenceService({ db, workspaceId: w.workspaceId }).set(
        w.authorId,
        Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [category, false])) as Record<
          (typeof NOTIFICATION_CATEGORIES)[number],
          boolean
        >,
      ),
    );
    await inTenant(w.workspaceId, (db) =>
      new WorkspaceTimezoneService({
        db,
        workspaceId: w.workspaceId,
        quota: { refund: async () => undefined },
        clock,
      }).change({
        toZone: 'Asia/Tokyo',
        actor: { type: 'USER', id: w.authorId },
        minLeadMinutes: POLICY.calendar.minLeadMinutes,
      }),
    );
    expect(
      (await platform.calendarSlot.findUniqueOrThrow({ where: { id: soon.slotId } })).status,
    ).toBe('PLANNED');
    expect(
      await platform.notification.findMany({
        where: { workspaceId: w.workspaceId, userId: w.authorId },
        select: { templateKey: true, resourceId: true },
      }),
    ).toEqual([{ templateKey: 'calendar.unplanned_by_timezone_change', resourceId: soon.slotId }]);
  });

  it('another workspace’s posts are never read or moved, and the same zone changes nothing', async () => {
    const mine = await world('UTC');
    const theirs = await world('UTC');
    const theirSlot = await slot(theirs, '2026-12-01T09:00', new Date(Date.UTC(2026, 11, 1, 9, 0)));
    const service = (db: TenantScopedClient) =>
      new WorkspaceTimezoneService({
        db,
        workspaceId: mine.workspaceId,
        quota: { refund: async () => undefined },
        clock,
      });
    const first = await inTenant(mine.workspaceId, (db) =>
      service(db).change({
        toZone: 'Europe/London',
        actor: { type: 'USER', id: mine.authorId },
        minLeadMinutes: 0,
      }),
    );
    expect(first.effects).toEqual([]);
    const again = await inTenant(mine.workspaceId, (db) =>
      service(db).change({
        toZone: 'Europe/London',
        actor: { type: 'USER', id: mine.authorId },
        minLeadMinutes: 0,
      }),
    );
    expect(again).toEqual({ from: 'Europe/London', effects: [] });
    expect(
      await platform.calendarSlot.findUniqueOrThrow({ where: { id: theirSlot.slotId } }),
    ).toMatchObject({ timezone: 'UTC', scheduledAtUtc: new Date(Date.UTC(2026, 11, 1, 9, 0)) });
  });

  it('refuses a zone that is not one', async () => {
    const w = await world('UTC');
    await expect(
      inTenant(w.workspaceId, (db) =>
        new WorkspaceTimezoneService({
          db,
          workspaceId: w.workspaceId,
          quota: { refund: async () => undefined },
          clock,
        }).change({
          toZone: 'Mars/Olympus',
          actor: { type: 'USER', id: w.authorId },
          minLeadMinutes: 0,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('G5 / Q22 · a post sent back to PLANNED goes out again only by being rescheduled', () => {
  it('moving it to a new time schedules it again, through the rules, taking the quota once', async () => {
    const w = await world('UTC');
    const soon = await slot(w, '2026-10-01T14:00', new Date(Date.UTC(2026, 9, 1, 14, 0)));
    await inTenant(w.workspaceId, (db) =>
      new WorkspaceTimezoneService({
        db,
        workspaceId: w.workspaceId,
        quota: { refund: async () => undefined },
        clock,
      }).change({
        toZone: 'Asia/Tokyo',
        actor: { type: 'USER', id: w.authorId },
        minLeadMinutes: POLICY.calendar.minLeadMinutes,
      }),
    );
    const consumed: string[] = [];
    const localTime = `${new Date().getUTCFullYear() + 1}-03-10T10:00`;
    const view = await inTenant(w.workspaceId, (db) =>
      new ContentCalendarService({
        channelGate: OPEN_CHANNEL_GATE,
        db,
        workspaceId: w.workspaceId,
        policy: POLICY,
        timezone: 'Asia/Tokyo',
        quota: {
          limit: async () => null,
          consume: async (key) => {
            consumed.push(key);
            return true;
          },
          refund: async () => undefined,
        },
        approvalGate: { policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }) },
      }).reschedule({
        slotId: soon.slotId,
        localTime,
        actorUserId: w.authorId,
        actorBrandScope: [],
      }),
    );
    expect(view.slot.status).toBe('SCHEDULED');
    expect(view.item.status).toBe('SCHEDULED');
    // Review item 13: the key is the slot's persisted attempt, which the refund
    // back to PLANNED moved from 0 to 1 — not the local time.
    expect(consumed).toEqual([`calendar:${w.workspaceId}:${soon.slotId}:attempt:1`]);
  });
});

/**
 * REVIEW ITEM 13 — THE SCHEDULING QUOTA KEY FOLLOWS `rescheduleAttempt`.
 *
 * The quota here is an idempotent fake keyed exactly like the real usage
 * service: a key it has seen is not charged again.
 */
function ledger() {
  const charged = new Set<string>();
  const refunded = new Set<string>();
  return {
    charged,
    refunded,
    quota: {
      limit: async () => null,
      consume: async (key: string) => {
        charged.add(key);
        return true;
      },
      refund: async (key: string) => void refunded.add(key),
    },
  };
}

function calendar(
  w: Awaited<ReturnType<typeof world>>,
  timezone: string,
  q: ReturnType<typeof ledger>,
) {
  return (db: TenantScopedClient) =>
    new ContentCalendarService({
      channelGate: OPEN_CHANNEL_GATE,
      db,
      workspaceId: w.workspaceId,
      policy: POLICY,
      timezone,
      quota: q.quota,
      approvalGate: { policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }) },
      // THE SUITE'S CLOCK, as every other service here gets. Without it the
      // service read the real clock, so "2026-10-01T14:00" was in the past from
      // about 14:00 UTC on 1 October 2026 onward and the test failed for ever.
      clock,
    });
}

function changeZone(
  w: Awaited<ReturnType<typeof world>>,
  toZone: string,
  q: ReturnType<typeof ledger>,
) {
  return inTenant(w.workspaceId, (db) =>
    new WorkspaceTimezoneService({ db, workspaceId: w.workspaceId, quota: q.quota, clock }).change({
      toZone,
      actor: { type: 'USER', id: w.authorId },
      minLeadMinutes: POLICY.calendar.minLeadMinutes,
    }),
  );
}

const attemptOf = async (slotId: string) =>
  (await platform.calendarSlot.findUniqueOrThrow({ where: { id: slotId } })).rescheduleAttempt;

describe('Review item 13 · a refund moves the scheduling key on; a retry never does', () => {
  it('old rows read 0, and attempt 0 is the key a slot always had', async () => {
    const w = await world('UTC');
    const s = await slot(w, '2026-12-01T09:00', new Date(Date.UTC(2026, 11, 1, 9, 0)));
    expect(await attemptOf(s.slotId)).toBe(0);
    expect(scheduleUsageKey(w.workspaceId, s.slotId, 0)).toBe(
      `calendar:${w.workspaceId}:${s.slotId}`,
    );
    expect(scheduleUsageKey(w.workspaceId, s.slotId, 2)).toBe(
      `calendar:${w.workspaceId}:${s.slotId}:attempt:2`,
    );
  });

  it('a refund back to PLANNED increments exactly once; repeating it neither refunds nor increments again', async () => {
    const w = await world('UTC');
    const soon = await slot(w, '2026-10-01T14:00', new Date(Date.UTC(2026, 9, 1, 14, 0)));
    const q = ledger();
    await changeZone(w, 'Asia/Tokyo', q);
    expect(await attemptOf(soon.slotId)).toBe(1);
    expect([...q.refunded]).toEqual([`${soon.usageKey}:refund`]);
    // Another zone where it is still too late: already PLANNED, so it only moves.
    await changeZone(w, 'Asia/Seoul', q);
    expect(await attemptOf(soon.slotId)).toBe(1);
    expect([...q.refunded]).toEqual([`${soon.usageKey}:refund`]);
    expect(
      (await platform.calendarSlot.findUniqueOrThrow({ where: { id: soon.slotId } })).status,
    ).toBe('PLANNED');
  });

  it('refund, then rescheduled to EXACTLY the same time, is charged again — each cycle under a new key', async () => {
    const w = await world('UTC');
    const soon = await slot(w, '2026-10-01T14:00', new Date(Date.UTC(2026, 9, 1, 14, 0)));
    const q = ledger();
    const sameTime = '2026-10-01T14:00';
    for (const cycle of [1, 2]) {
      // Too late in Tokyo: refunded back to PLANNED, the attempt moves on.
      await changeZone(w, 'Asia/Tokyo', q);
      // Back to UTC, where 14:00 is still ahead; then put back at the SAME time.
      await changeZone(w, 'UTC', q);
      const view = await inTenant(w.workspaceId, (db) =>
        calendar(
          w,
          'UTC',
          q,
        )(db).reschedule({
          slotId: soon.slotId,
          localTime: sameTime,
          actorUserId: w.authorId,
          actorBrandScope: [],
        }),
      );
      expect(view.slot.status).toBe('SCHEDULED');
      expect(await attemptOf(soon.slotId)).toBe(cycle);
      expect(q.charged.has(`calendar:${w.workspaceId}:${soon.slotId}:attempt:${cycle}`)).toBe(true);
    }
    expect([...q.charged]).toEqual([
      `calendar:${w.workspaceId}:${soon.slotId}:attempt:1`,
      `calendar:${w.workspaceId}:${soon.slotId}:attempt:2`,
    ]);
  });

  it('a retried scheduling request reuses the same persisted attempt and key, and does not increment it', async () => {
    const w = await world('UTC');
    const soon = await slot(w, '2026-10-01T14:00', new Date(Date.UTC(2026, 9, 1, 14, 0)));
    const q = ledger();
    await changeZone(w, 'Asia/Tokyo', q);
    await changeZone(w, 'UTC', q);
    const keys: string[] = [];
    const recording = {
      ...q.quota,
      consume: async (key: string) => {
        keys.push(key);
        return q.quota.consume(key);
      },
    };
    const request = () =>
      inTenant(w.workspaceId, (db) =>
        new ContentCalendarService({
          channelGate: OPEN_CHANNEL_GATE,
          db,
          workspaceId: w.workspaceId,
          policy: POLICY,
          timezone: 'UTC',
          quota: recording,
          approvalGate: {
            policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
          },
          clock,
        }).reschedule({
          slotId: soon.slotId,
          localTime: '2026-10-01T15:00',
          actorUserId: w.authorId,
          actorBrandScope: [],
        }),
      );
    // The first delivery is lost after the charge: its transaction rolls back.
    await expect(
      inTenant(w.workspaceId, async (db) => {
        await new ContentCalendarService({
          channelGate: OPEN_CHANNEL_GATE,
          db,
          workspaceId: w.workspaceId,
          policy: POLICY,
          timezone: 'UTC',
          quota: recording,
          approvalGate: {
            policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
          },
          clock,
        }).reschedule({
          slotId: soon.slotId,
          localTime: '2026-10-01T15:00',
          actorUserId: w.authorId,
          actorBrandScope: [],
        });
        throw new Error('the request died after charging');
      }),
    ).rejects.toThrow(/died/);
    expect(await attemptOf(soon.slotId)).toBe(1);
    // The retry: the same attempt, so the same key — the fake, like the usage
    // service, charges a key once.
    await request();
    expect(keys).toEqual([
      `calendar:${w.workspaceId}:${soon.slotId}:attempt:1`,
      `calendar:${w.workspaceId}:${soon.slotId}:attempt:1`,
    ]);
    expect(q.charged.size).toBe(1);
    expect(await attemptOf(soon.slotId)).toBe(1);
  });
});

describe('Review item 14 · every query names the workspace, not only RLS', () => {
  it('run on the RLS-free platform connection, a change in one workspace moves nothing of another', async () => {
    const mine = await world('UTC');
    const theirs = await world('UTC');
    const theirSoon = await slot(theirs, '2026-10-01T14:00', new Date(Date.UTC(2026, 9, 1, 14, 0)));
    const mineSoon = await slot(mine, '2026-10-01T14:00', new Date(Date.UTC(2026, 9, 1, 14, 0)));
    const q = ledger();
    // THE PLATFORM CLIENT BYPASSES RLS: the workspace predicates are the only guard.
    await platform.$transaction((tx) =>
      new WorkspaceTimezoneService({
        db: tx as unknown as TenantScopedClient,
        workspaceId: mine.workspaceId,
        quota: q.quota,
        clock,
      }).change({
        toZone: 'Asia/Tokyo',
        actor: { type: 'USER', id: mine.authorId },
        minLeadMinutes: POLICY.calendar.minLeadMinutes,
      }),
    );
    expect(
      await platform.calendarSlot.findUniqueOrThrow({ where: { id: mineSoon.slotId } }),
    ).toMatchObject({ status: 'PLANNED', rescheduleAttempt: 1 });
    expect(
      await platform.calendarSlot.findUniqueOrThrow({ where: { id: theirSoon.slotId } }),
    ).toMatchObject({ status: 'SCHEDULED', timezone: 'UTC', rescheduleAttempt: 0 });
    expect(
      (await platform.contentItem.findUniqueOrThrow({ where: { id: theirSoon.itemId } })).status,
    ).toBe('SCHEDULED');
    expect([...q.refunded]).toEqual([`${mineSoon.usageKey}:refund`]);
  });

  it('the source: every slot, item and approval query in the service carries workspaceId', () => {
    const source = readFileSync(
      path.join(__dirname, '../../packages/content/src/timezone-change.ts'),
      'utf8',
    );
    const calls = [
      ...source.matchAll(
        /this\.#db\.(calendarSlot|contentItem|approval)\.(\w+)\(\{\s*where:\s*\{([^}]*)\}/g,
      ),
    ];
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls) expect(call[3], `${call[1]}.${call[2]}`).toContain('workspaceId');
  });
});
