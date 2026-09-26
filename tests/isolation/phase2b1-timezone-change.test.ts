import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfigPayload } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  ContentCalendarService,
  WorkspaceTimezoneService,
  parseContentPolicy,
  timezoneChangeEffects,
} from '@brandspace/content';
import { appRoleClient, platformRoleClient } from './fixtures';

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
    expect(consumed).toEqual([`calendar:${w.workspaceId}:${soon.slotId}:replan:${localTime}`]);
  });
});
