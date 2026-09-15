import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Cross-tenant and cross-BRAND isolation for the model Phase 5B-2's calendar
 * adds.
 *
 * The D-29 gate requires this file. `CalendarSlot` gets the assertions every
 * earlier phase established — a direct read of B's row from A returns null, a
 * listing from A excludes B, a write aimed at B is refused, and an aggregate is
 * treated as a read — plus the two properties specific to a PLAN:
 *
 *   - A CALENDAR IS A COMPETITOR'S MOST USEFUL DOCUMENT. A draft caption
 *     leaking is bad; the DATE an unannounced launch goes out is a company's
 *     strategy on a plate. So the slot's instant and its local intent are
 *     asserted separately from the row's existence.
 *
 *   - `calendar_slot.contentItemId` IS F-80 AND F-83'S SHAPE — a child pointing
 *     at a tenant-owned parent by id alone — and it is the second key written
 *     since D-112 made the composite form the platform rule. So the refusal is
 *     asserted from inside A's OWN workspace context, which is the case RLS
 *     does not cover and the case both findings were about.
 *
 * Everything runs through `withWorkspace()`, so PostgreSQL RLS — not a `where`
 * clause a test remembered — is what is being measured.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

function inA<T>(fn: (db: Parameters<Parameters<typeof withWorkspace>[1]>[0]) => Promise<T>) {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });
}

describe('CalendarSlot is tenant-owned', () => {
  it('A cannot read B slot by id', async () => {
    const row = await inA((db) =>
      db.calendarSlot.findUnique({ where: { id: fixtures.b.calendarSlotId } }),
    );
    expect(row).toBeNull();
  });

  it("A's calendar excludes B", async () => {
    const rows = await inA((db) => db.calendarSlot.findMany());
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.calendarSlotId);
    expect(rows.map((r) => r.id)).toContain(fixtures.a.calendarSlotId);
  });

  it("A cannot count B's plan — an aggregate is a read", async () => {
    const count = await inA((db) =>
      db.calendarSlot.count({ where: { brandId: fixtures.b.brandId } }),
    );
    expect(count).toBe(0);
  });

  it('A cannot learn WHEN B publishes, by any range query', async () => {
    /*
     * THE DISCLOSURE THAT MATTERS MOST HERE. The row's existence is one thing;
     * the DATE is the competitor-useful fact. A range query spanning every slot
     * either tenant holds must still return only A's.
     */
    const rows = await inA((db) =>
      db.calendarSlot.findMany({
        where: { scheduledAtUtc: { gte: new Date('2000-01-01T00:00:00Z') } },
        select: { id: true, scheduledAtUtc: true, scheduledLocalTime: true },
      }),
    );
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.calendarSlotId);
    expect(rows.every((r) => r.id === fixtures.a.calendarSlotId)).toBe(true);
  });

  it('A cannot write a slot into B', async () => {
    await expect(
      inA((db) =>
        db.calendarSlot.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            contentItemId: fixtures.b.contentItemId,
            scheduledAtUtc: new Date('2030-01-01T09:00:00Z'),
            scheduledLocalTime: '2030-01-01T12:00',
            timezone: 'Asia/Riyadh',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("A cannot plan B's DRAFT from inside its own workspace — F-80/F-83's shape", async () => {
    /*
     * THE CASE RLS DOES NOT COVER, and the reason D-112 exists.
     *
     * The row carries A's own workspaceId, so the tenant policy admits it and
     * the insert reaches the constraints. Referential integrity then runs with
     * RLS BYPASSED — so a plain `contentItemId` would have resolved B's draft
     * perfectly well and accepted the row, putting B's content on A's calendar.
     * `calendar_slot_item_fkey` on `(workspaceId, contentItemId)` is what
     * refuses it: the PAIR does not exist.
     */
    await expect(
      inA((db) =>
        db.calendarSlot.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: fixtures.b.contentItemId,
            scheduledAtUtc: new Date('2030-01-01T09:00:00Z'),
            scheduledLocalTime: '2030-01-01T12:00',
            timezone: 'Asia/Riyadh',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("A cannot attach its own draft to B's brand — the composite key refuses it", async () => {
    await expect(
      inA((db) =>
        db.calendarSlot.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.b.brandId,
            contentItemId: fixtures.a.contentItemId,
            scheduledAtUtc: new Date('2030-01-01T09:00:00Z'),
            scheduledLocalTime: '2030-01-01T12:00',
            timezone: 'Asia/Riyadh',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a real foreign draft id and a fabricated one fail identically', async () => {
    /*
     * THE ORACLE, CLOSED RATHER THAN MOVED. A boundary that refused a real
     * foreign id with one error and an invented one with another would still
     * answer "does this id name a draft?". Both must be indistinguishable.
     */
    const attempt = (contentItemId: string) =>
      inA((db) =>
        db.calendarSlot.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId,
            scheduledAtUtc: new Date('2031-02-02T09:00:00Z'),
            scheduledLocalTime: '2031-02-02T12:00',
            timezone: 'Asia/Riyadh',
          },
        }),
      );

    const observe = async (promise: Promise<unknown>) => {
      try {
        await promise;
        throw new Error('ACCEPTED');
      } catch (error: unknown) {
        const e = error as {
          code?: unknown;
          meta?: {
            driverAdapterError?: {
              cause?: { originalCode?: unknown; constraint?: { index?: unknown } };
            };
          };
        };
        const cause = e.meta?.driverAdapterError?.cause;
        return {
          code: String(e.code),
          sqlState: String(cause?.originalCode),
          constraint: String(cause?.constraint?.index),
        };
      }
    };

    const real = await observe(attempt(fixtures.b.contentItemId));
    const invented = await observe(attempt(randomUUID()));
    expect(real).toEqual(invented);
    expect(real.constraint).toBe('calendar_slot_item_fkey');
  });

  it('A cannot move B slot', async () => {
    const result = await inA((db) =>
      db.calendarSlot.updateMany({
        where: { id: fixtures.b.calendarSlotId },
        data: { scheduledAtUtc: new Date('2032-05-05T09:00:00Z') },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('A cannot cancel B slot', async () => {
    const result = await inA((db) =>
      db.calendarSlot.updateMany({
        where: { id: fixtures.b.calendarSlotId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('A cannot delete B slot', async () => {
    const result = await inA((db) =>
      db.calendarSlot.deleteMany({ where: { id: fixtures.b.calendarSlotId } }),
    );
    expect(result.count).toBe(0);
  });
});

describe('the calendar table carries the platform guarantees', () => {
  it('RLS is ENABLED and FORCED', async () => {
    const rows = await app.$queryRawUnsafe<{ relname: string; ok: boolean }[]>(
      `SELECT relname, (relrowsecurity AND relforcerowsecurity) AS ok
         FROM pg_class WHERE relname = 'calendar_slot'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(true);
  });

  it('every foreign key to a tenant-owned parent is composite (D-112)', async () => {
    const rows = await app.$queryRawUnsafe<{ relation: string }[]>(
      `SELECT c.conrelid::regclass::text || '.' || c.conname AS relation
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'f'
          AND t.relname = 'calendar_slot'
          AND cardinality(c.conkey) = 1
          AND c.confrelid <> 'workspace'::regclass`,
    );
    expect(rows.map((r) => r.relation)).toEqual([]);
  });

  it('a local wall-clock must be a wall-clock, and the DATABASE says so', async () => {
    /*
     * The service is not the only guard. `scheduledLocalTime` is free text to
     * PostgreSQL, and a column whose shape only the service enforces is a
     * column that eventually holds whatever a future call site passes — at
     * which point the instant can no longer be recomputed from the intent,
     * which is the one thing the column exists for.
     *
     * Run INSIDE A's context so the row is visible and the CHECK actually
     * fires; outside it, RLS would report zero rows changed and this would pass
     * for the wrong reason.
     */
    await expect(
      inA((db) =>
        db.$executeRawUnsafe(
          `UPDATE "calendar_slot" SET "scheduledLocalTime" = '12 March, 9am' WHERE "id" = $1::uuid`,
          fixtures.a.calendarSlotId,
        ),
      ),
    ).rejects.toThrow();

    // An offset is refused too: it would be a second, contradictory answer to
    // the question `timezone` already answers.
    await expect(
      inA((db) =>
        db.$executeRawUnsafe(
          `UPDATE "calendar_slot" SET "scheduledLocalTime" = '2030-03-12T09:00+03:00' WHERE "id" = $1::uuid`,
          fixtures.a.calendarSlotId,
        ),
      ),
    ).rejects.toThrow();
  });

  it('a cancelled slot must carry its cancellation time, and a live one must not', async () => {
    await expect(
      inA((db) =>
        db.$executeRawUnsafe(
          `UPDATE "calendar_slot" SET "status" = 'CANCELLED' WHERE "id" = $1::uuid`,
          fixtures.a.calendarSlotId,
        ),
      ),
    ).rejects.toThrow();
  });

  it('one live slot per content item, and a cancelled one does not block a new plan', async () => {
    /*
     * The partial unique index. Two live slots for the same draft is a calendar
     * showing the same post twice and a quota charged twice — and the service
     * refusing it is not the same as the database refusing it, because the
     * service can be bypassed by the next call site or a raw statement.
     */
    await expect(
      inA((db) =>
        db.calendarSlot.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: fixtures.a.contentItemId,
            scheduledAtUtc: new Date('2033-06-06T09:00:00Z'),
            scheduledLocalTime: '2033-06-06T12:00',
            timezone: 'Asia/Riyadh',
            status: 'SCHEDULED',
          },
        }),
      ),
    ).rejects.toThrow();

    // And the index is PARTIAL, so cancelling frees the item to be planned
    // again — a full unique index would strand the draft for ever.
    const extra = await inA(async (db) => {
      const cancelled = await db.calendarSlot.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          contentItemId: fixtures.a.contentItemId,
          scheduledAtUtc: new Date('2033-07-07T09:00:00Z'),
          scheduledLocalTime: '2033-07-07T12:00',
          timezone: 'Asia/Riyadh',
          status: 'CANCELLED',
          cancelledAt: new Date(),
        },
      });
      return cancelled.id;
    });
    expect(extra).toBeTruthy();
    await inA((db) => db.calendarSlot.delete({ where: { id: extra } }));
  });
});
