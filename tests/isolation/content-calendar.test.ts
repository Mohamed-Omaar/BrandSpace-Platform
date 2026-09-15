import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { UsageService, QUOTA_FEATURES } from '@brandspace/entitlements';
import {
  ContentCalendarService,
  ContentLibraryService,
  formatLocalTime,
  type ContentPolicy,
  type ScheduleQuota,
} from '@brandspace/content';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * The Content Calendar against a real PostgreSQL and the REAL usage service —
 * `docs/MVP-ACCEPTANCE-CRITERIA.md` §15 (AC-14.1 … AC-14.9), measured rather
 * than asserted.
 *
 * Every content read and write runs on the TENANT pool inside a workspace
 * transaction, so RLS applies to all of it; the quota runs on the platform pool
 * exactly as it does in the dashboard. That split is under test as much as the
 * scheduling is.
 *
 * NOTHING HERE PUBLISHES, AND NOTHING CAN (AC-14.7). No connector is imported,
 * no network is reachable, and every slot's `targetKind` is asserted to be the
 * mock.
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
  approvals: {
    requireApprovalBeforeScheduling: false,
    allowSelfApproval: false,
    clientApprovalEnabled: false,
    maxNoteLength: 1_000,
    maxCyclesPerItem: 25,
  },
};

const ZONE = 'Asia/Riyadh';

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let usage: UsageService;

/** The ceiling this run's quota enforces. Rewritten per test that needs it. */
let quotaLimit: number | null = null;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  platform = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL'] ?? '' }),
  });
  usage = new UsageService({ prisma: platform });

  // The fixture ships one live slot so the tenancy suite has something to
  // measure. This suite creates its own, so that one is taken off first.
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.calendarSlot.deleteMany({});
      await db.contentItem.updateMany({ data: { status: 'DRAFT' } });
    },
    { prisma: app },
  );
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

/** The real usage service behind the interface the calendar takes. */
function quota(): ScheduleQuota {
  return {
    limit: async () => quotaLimit,
    consume: async (idempotencyKey) => {
      try {
        await usage.consume({
          workspaceId: fixtures.a.workspaceId,
          featureKey: QUOTA_FEATURES.scheduledPostsPerMonth,
          limitValue: quotaLimit,
          period: 'month',
          idempotencyKey,
        });
        return true;
      } catch {
        return false;
      }
    },
    refund: async (idempotencyKey) => {
      await usage.refund({
        workspaceId: fixtures.a.workspaceId,
        featureKey: QUOTA_FEATURES.scheduledPostsPerMonth,
        period: 'month',
        idempotencyKey,
      });
    },
  };
}

function inA<T>(
  fn: (
    calendar: ContentCalendarService,
    db: Parameters<Parameters<typeof withWorkspace>[1]>[0],
  ) => Promise<T>,
  zone = ZONE,
): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new ContentCalendarService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          timezone: zone,
          quota: quota(),
        }),
        db,
      ),
    { prisma: app },
  );
}

/** A fresh draft with one variant — the shape the calendar will accept. */
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

/** A wall-clock a comfortable distance in the future, so nothing is "too soon". */
let dayCursor = 0;
function futureLocal(hour = 9): string {
  dayCursor += 1;
  const when = new Date(Date.now() + (30 + dayCursor) * 24 * 3_600_000);
  const day = when.toISOString().slice(0, 10);
  return `${day}T${String(hour).padStart(2, '0')}:00`;
}

const actor = () => ({ actorUserId: fixtures.a.userId, actorBrandScope: [] as string[] });

// ---------------------------------------------------------------------------

describe('AC-14.1 and AC-14.2 — a draft is placed on the calendar, with its intent', () => {
  it('creates a slot storing the UTC instant, the intended local time and the zone', async () => {
    const contentItemId = await makeDraft('Launch announcement');
    const localTime = futureLocal(9);

    const { slot, item } = await inA((calendar) =>
      calendar.schedule({ contentItemId, localTime, ...actor() }),
    );

    // AC-14.2 — all three, and they agree.
    expect(slot.scheduledLocalTime).toBe(localTime);
    expect(slot.timezone).toBe(ZONE);
    expect(formatLocalTime(slot.scheduledAtUtc, ZONE)).toBe(localTime);
    // Riyadh is UTC+3 all year, so 09:00 local is 06:00Z — arithmetic a reader
    // can check rather than a value copied from the implementation.
    expect(slot.scheduledAtUtc.toISOString().slice(11, 16)).toBe('06:00');

    // The item and the slot moved together.
    expect(item.status).toBe('SCHEDULED');

    // AC-14.7 — the target is a mock, in the data.
    expect(slot.targetKind).toBe('MOCK');

    // The channels came from the item's variants rather than from the caller.
    expect(slot.platformKeys).toEqual(['instagram']);
  });

  it('refuses a draft with no caption — a plan to publish nothing is not a plan', async () => {
    const bare = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        (
          await db.contentItem.create({
            data: {
              workspaceId: fixtures.a.workspaceId,
              brandId: fixtures.a.brandId,
              title: 'No captions',
              primaryLocale: 'EN',
              status: 'DRAFT',
            },
          })
        ).id,
      { prisma: app },
    );

    await expect(
      inA((calendar) =>
        calendar.schedule({ contentItemId: bare, localTime: futureLocal(), ...actor() }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a second live slot for the same draft', async () => {
    const contentItemId = await makeDraft('Only once');
    await inA((calendar) =>
      calendar.schedule({ contentItemId, localTime: futureLocal(), ...actor() }),
    );
    await expect(
      inA((calendar) => calendar.schedule({ contentItemId, localTime: futureLocal(), ...actor() })),
    ).rejects.toThrow();
  });
});

describe('AC-14.3 — the local time is right in another zone, and across a DST boundary', () => {
  it('the same instant renders as different wall-clocks in different zones', async () => {
    const contentItemId = await makeDraft('Read from elsewhere');
    const localTime = futureLocal(9);
    const { slot } = await inA((calendar) =>
      calendar.schedule({ contentItemId, localTime, ...actor() }),
    );

    // The slot means one instant. A viewer in London reads it as their own
    // wall-clock; the STORED intent is unchanged, which is the point.
    const inLondon = formatLocalTime(slot.scheduledAtUtc, 'Europe/London');
    expect(inLondon).not.toBe(localTime);
    expect(formatLocalTime(slot.scheduledAtUtc, ZONE)).toBe(localTime);
  });

  it('a workspace in a DST zone keeps the wall-clock it chose on both sides of a transition', async () => {
    /*
     * THE CRITERION'S HARD HALF. New York is UTC-5 in winter and UTC-4 in
     * summer. A customer who schedules 09:00 in January and 09:00 in July means
     * 09:00 both times — and the two slots are therefore a DIFFERENT number of
     * hours from UTC. A single stored timestamp cannot express that; the intent
     * plus the zone can.
     */
    const winterItem = await makeDraft('Winter post');
    const summerItem = await makeDraft('Summer post');
    const year = new Date().getUTCFullYear() + 1;

    const winter = await inA(
      (calendar) =>
        calendar.schedule({
          contentItemId: winterItem,
          localTime: `${year}-01-15T09:00`,
          ...actor(),
        }),
      'America/New_York',
    );
    const summer = await inA(
      (calendar) =>
        calendar.schedule({
          contentItemId: summerItem,
          localTime: `${year}-07-15T09:00`,
          ...actor(),
        }),
      'America/New_York',
    );

    expect(formatLocalTime(winter.slot.scheduledAtUtc, 'America/New_York')).toBe(
      `${year}-01-15T09:00`,
    );
    expect(formatLocalTime(summer.slot.scheduledAtUtc, 'America/New_York')).toBe(
      `${year}-07-15T09:00`,
    );

    // 14:00Z in winter (EST, -5) and 13:00Z in summer (EDT, -4). Different
    // instants for the same wall-clock — which is exactly right.
    expect(winter.slot.scheduledAtUtc.toISOString().slice(11, 16)).toBe('14:00');
    expect(summer.slot.scheduledAtUtc.toISOString().slice(11, 16)).toBe('13:00');
  });
});

describe('AC-14.5 — the plan quota is enforced, and refunded', () => {
  it('refuses a slot beyond the monthly ceiling, and the refusal is QUOTA_EXCEEDED', async () => {
    // A ceiling this run can actually reach. The counter is per workspace per
    // calendar month, so the limit is set just above what is already consumed.
    const current = await usage.consumption({
      workspaceId: fixtures.a.workspaceId,
      featureKey: QUOTA_FEATURES.scheduledPostsPerMonth,
      limitValue: null,
      period: 'month',
    });
    quotaLimit = current.used + 1;

    const first = await makeDraft('Within the plan');
    await inA((calendar) =>
      calendar.schedule({ contentItemId: first, localTime: futureLocal(), ...actor() }),
    );

    const second = await makeDraft('Beyond the plan');
    await expect(
      inA((calendar) =>
        calendar.schedule({ contentItemId: second, localTime: futureLocal(), ...actor() }),
      ),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });

    // AND NOTHING WAS WRITTEN. A refusal that left a slot behind would be a
    // calendar entry the customer was told they could not have.
    const slots = await withWorkspace(
      fixtures.a.workspaceId,
      (db) => db.calendarSlot.count({ where: { contentItemId: second } }),
      { prisma: app },
    );
    expect(slots).toBe(0);

    quotaLimit = null;
  });

  it('cancelling gives the quota back', async () => {
    const before = await usage.consumption({
      workspaceId: fixtures.a.workspaceId,
      featureKey: QUOTA_FEATURES.scheduledPostsPerMonth,
      limitValue: null,
      period: 'month',
    });

    const contentItemId = await makeDraft('Taken back off');
    const { slot } = await inA((calendar) =>
      calendar.schedule({ contentItemId, localTime: futureLocal(), ...actor() }),
    );

    const during = await usage.consumption({
      workspaceId: fixtures.a.workspaceId,
      featureKey: QUOTA_FEATURES.scheduledPostsPerMonth,
      limitValue: null,
      period: 'month',
    });
    expect(during.used).toBe(before.used + 1);

    await inA((calendar) => calendar.cancel({ slotId: slot.id, ...actor() }));

    const after = await usage.consumption({
      workspaceId: fixtures.a.workspaceId,
      featureKey: QUOTA_FEATURES.scheduledPostsPerMonth,
      limitValue: null,
      period: 'month',
    });
    expect(after.used).toBe(before.used);
  });
});

describe('AC-14.6 — approval, when the policy requires it', () => {
  it('refuses an unapproved item while the gate is on, and admits an approved one', async () => {
    const strict: ContentPolicy = {
      ...CONTENT_POLICY,
      calendar: { ...CONTENT_POLICY.calendar, requireApprovalBeforeScheduling: true },
    };

    const contentItemId = await makeDraft('Needs a reviewer');

    const withGate = <T>(fn: (calendar: ContentCalendarService) => Promise<T>): Promise<T> =>
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          fn(
            new ContentCalendarService({
              db,
              workspaceId: fixtures.a.workspaceId,
              policy: strict,
              timezone: ZONE,
              quota: quota(),
            }),
          ),
        { prisma: app },
      );

    await expect(
      withGate((calendar) =>
        calendar.schedule({ contentItemId, localTime: futureLocal(), ...actor() }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // The gate is a GATE, not a blanket refusal: an approved item passes it.
    // Nothing in this phase can set APPROVED — that is the Approvals module's,
    // 5B-3 — so the state is written directly here, which is the honest way to
    // test a gate whose other side does not exist yet.
    await withWorkspace(
      fixtures.a.workspaceId,
      (db) => db.contentItem.update({ where: { id: contentItemId }, data: { status: 'APPROVED' } }),
      { prisma: app },
    );

    const { slot } = await withGate((calendar) =>
      calendar.schedule({ contentItemId, localTime: futureLocal(), ...actor() }),
    );
    expect(slot.status).toBe('SCHEDULED');
  });
});

describe('AC-14.8 and AC-14.9 — moving, cancelling, and the audit trail', () => {
  it('rescheduling moves the slot and records both times', async () => {
    const contentItemId = await makeDraft('Moves later');
    const first = futureLocal(9);
    const { slot } = await inA((calendar) =>
      calendar.schedule({ contentItemId, localTime: first, ...actor() }),
    );

    const second = futureLocal(17);
    const moved = await inA((calendar) =>
      calendar.reschedule({ slotId: slot.id, localTime: second, ...actor() }),
    );

    expect(moved.slot.scheduledLocalTime).toBe(second);
    expect(formatLocalTime(moved.slot.scheduledAtUtc, ZONE)).toBe(second);

    const events = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        db.auditEvent.findMany({
          where: { resourceId: slot.id, action: 'content.rescheduled' },
          orderBy: { occurredAt: 'desc' },
        }),
      { prisma: app },
    );
    expect(events).toHaveLength(1);
    const after = events[0]?.after as Record<string, unknown> | null;
    expect(after?.['fromLocalTime']).toBe(first);
    expect(after?.['toLocalTime']).toBe(second);
  });

  it('cancelling takes it off the calendar and returns the item to DRAFT', async () => {
    const contentItemId = await makeDraft('Called off');
    const { slot } = await inA((calendar) =>
      calendar.schedule({ contentItemId, localTime: futureLocal(), ...actor() }),
    );

    const cancelled = await inA((calendar) => calendar.cancel({ slotId: slot.id, ...actor() }));
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelledAt).not.toBeNull();

    const item = await withWorkspace(
      fixtures.a.workspaceId,
      (db) => db.contentItem.findUnique({ where: { id: contentItemId } }),
      { prisma: app },
    );
    expect(item?.status).toBe('DRAFT');

    // And it is off the calendar's own listing.
    const still = await inA((calendar) =>
      calendar.listSlots({
        start: new Date('2000-01-01T00:00:00Z'),
        end: new Date('2100-01-01T00:00:00Z'),
      }),
    );
    expect(still.map((view) => view.slot.id)).not.toContain(slot.id);
  });

  it('AC-14.9 — content.scheduled exists, and carries times rather than captions', async () => {
    const contentItemId = await makeDraft('Audited');
    const localTime = futureLocal(11);
    const { slot } = await inA((calendar) =>
      calendar.schedule({ contentItemId, localTime, ...actor() }),
    );

    const events = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        db.auditEvent.findMany({ where: { resourceId: slot.id, action: 'content.scheduled' } }),
      { prisma: app },
    );
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event?.resourceType).toBe('CalendarSlot');
    expect(event?.brandId).toBe(fixtures.a.brandId);

    const after = event?.after as Record<string, unknown> | null;
    expect(after?.['scheduledLocalTime']).toBe(localTime);
    expect(after?.['timezone']).toBe(ZONE);

    // NEVER THE CAPTION. A scheduled launch caption is the most commercially
    // sensitive string the product holds, and an audit record is read by more
    // people than the draft is.
    expect(JSON.stringify(event?.after)).not.toContain('A caption.');
    expect(JSON.stringify(event?.after)).not.toContain('Audited');
  });

  it('a cancelled slot frees the draft to be planned again', async () => {
    const contentItemId = await makeDraft('Twice, legitimately');
    const { slot } = await inA((calendar) =>
      calendar.schedule({ contentItemId, localTime: futureLocal(), ...actor() }),
    );
    await inA((calendar) => calendar.cancel({ slotId: slot.id, ...actor() }));

    const again = await inA((calendar) =>
      calendar.schedule({ contentItemId, localTime: futureLocal(), ...actor() }),
    );
    expect(again.slot.id).not.toBe(slot.id);
    expect(again.slot.status).toBe('SCHEDULED');
  });
});

describe('the bounds the activated policy sets', () => {
  it('refuses a time already past, or inside the minimum notice', async () => {
    const contentItemId = await makeDraft('Too soon');
    const yesterday = formatLocalTime(new Date(Date.now() - 24 * 3_600_000), ZONE);
    await expect(
      inA((calendar) => calendar.schedule({ contentItemId, localTime: yesterday, ...actor() })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a date beyond the planning horizon', async () => {
    const contentItemId = await makeDraft('Too far');
    const far = formatLocalTime(new Date(Date.now() + 400 * 24 * 3_600_000), ZONE);
    await expect(
      inA((calendar) => calendar.schedule({ contentItemId, localTime: far, ...actor() })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a wall-clock that is not one', async () => {
    const contentItemId = await makeDraft('Not a time');
    for (const bad of ['tomorrow at nine', '2030-02-31T09:00', '2030-13-01T09:00']) {
      await expect(
        inA((calendar) => calendar.schedule({ contentItemId, localTime: bad, ...actor() })),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});

describe('the month view answers in the workspace’s own month', () => {
  it('includes a slot at the very start of a local month, which a UTC query would miss', async () => {
    /*
     * THE BUG THIS TEST EXISTS FOR. Riyadh is UTC+3, so 00:30 on the first of a
     * local month is 21:30 on the LAST day of the previous month in UTC. A
     * month view that queried a UTC range would put that post on the wrong
     * page — and the customer would open the month their post is in and not
     * find it.
     */
    const contentItemId = await makeDraft('First thing on the first');
    const base = new Date(Date.now() + 60 * 24 * 3_600_000);
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth() + 1;
    const localTime = `${year}-${String(month).padStart(2, '0')}-01T00:30`;

    const { slot } = await inA((calendar) =>
      calendar.schedule({ contentItemId, localTime, ...actor() }),
    );
    // Its UTC instant really is in the previous month.
    expect(slot.scheduledAtUtc.getUTCMonth() + 1).not.toBe(month);

    const view = await inA((calendar) => calendar.monthView({ year, month }));
    expect(view.map((entry) => entry.slot.id)).toContain(slot.id);
  });
});

describe('nothing in this module can publish (AC-14.7)', () => {
  it('every slot targets the mock, and no other target is expressible', async () => {
    const slots = await withWorkspace(
      fixtures.a.workspaceId,
      (db) => db.calendarSlot.findMany({ select: { targetKind: true } }),
      { prisma: app },
    );
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) expect(slot.targetKind).toBe('MOCK');
  });

  it('the calendar service imports no connector and no transport', async () => {
    /*
     * Asserted against the SOURCE, because "we did not call a social API" is
     * exactly the sort of claim that stays true until somebody adds an import.
     */
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(
      path.resolve(__dirname, '../../packages/content/src/calendar.ts'),
      'utf8',
    );
    for (const forbidden of ['fetch(', 'node:http', 'axios', 'social-connectors', 'undici']) {
      expect(source, `the calendar reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('the library and the calendar agree about a scheduled item', () => {
  it('an item on the calendar cannot be archived out from under its slot', async () => {
    const contentItemId = await makeDraft('Locked while planned');
    await inA((calendar) =>
      calendar.schedule({ contentItemId, localTime: futureLocal(), ...actor() }),
    );

    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          new ContentLibraryService({
            db,
            workspaceId: fixtures.a.workspaceId,
            policy: CONTENT_POLICY,
          }).transition({ itemId: contentItemId, to: 'ARCHIVED', ...actor() }),
        { prisma: app },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
