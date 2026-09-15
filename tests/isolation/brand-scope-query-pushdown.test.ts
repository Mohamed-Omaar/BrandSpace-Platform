import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import {
  ContentCalendarService,
  ContentLibraryService,
  type ContentPolicy,
} from '@brandspace/content';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * BrandScope is a QUERY PREDICATE, not a post-retrieval filter.
 *
 * WHY THIS SUITE EXISTS. The cross-phase audit found the calendar page fetching
 * the whole workspace's month and then dropping out-of-scope brands in
 * JavaScript. RLS kept another TENANT's rows out, so nothing leaked across
 * workspaces — but two things followed from filtering late:
 *
 *   1. Rows the reader may not see were fetched on their behalf, so any count
 *      or page boundary computed from that list would have been computed over
 *      invisible rows. That is the same defect the Activity Log was corrected
 *      for in Phase 5B-3.
 *   2. `listItems` applies `limit` IN THE DATABASE. Filtering by brand after it
 *      returned meant filtering a page that had ALREADY been truncated — so a
 *      member scoped to one brand, in a workspace whose most recent drafts
 *      belong to another, was shown NOTHING and told it was empty.
 *
 * The second is a real correctness bug rather than a purely architectural one,
 * and it is what this suite pins. Both services now take `brandScope` and apply
 * it through `brandIdScopeFilter`, which reads empty as UNRESTRICTED.
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

let app: PrismaClient;
let fixtures: IsolationFixtures;
let otherBrandId: string;

/** How many drafts the "truncation" case puts in the OTHER brand. */
const NOISE = 12;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);

  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const brand = await db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `scope-probe-${randomUUID().slice(0, 8)}`,
          name: 'Scope Probe Brand',
          defaultLocale: 'EN',
          status: 'ACTIVE',
        },
      });
      otherBrandId = brand.id;

      // ONE DRAFT IN THE MEMBER'S OWN BRAND, created FIRST so every noise
      // draft below is strictly newer. `listItems` orders newest-first, so
      // this row is the one a truncated page loses.
      const mine = await db.contentItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          title: 'In-scope draft',
          primaryLocale: 'EN',
          status: 'DRAFT',
          createdByUserId: fixtures.a.userId,
        },
      });
      await db.contentVariant.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          contentItemId: mine.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: 'Mine.',
          characterCount: 5,
          validationState: 'VALID',
        },
      });

      // Newest-first ordering means these crowd out the in-scope draft.
      for (let i = 0; i < NOISE; i += 1) {
        const item = await db.contentItem.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: brand.id,
            title: `Other brand draft ${i}`,
            primaryLocale: 'EN',
            status: 'DRAFT',
            createdByUserId: fixtures.a.userId,
          },
        });
        await db.contentVariant.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: brand.id,
            contentItemId: item.id,
            platformKey: 'instagram',
            locale: 'EN',
            body: 'Noise.',
            characterCount: 6,
            validationState: 'VALID',
          },
        });
      }
    },
    { prisma: app },
  );
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
});

const library = <T>(fn: (s: ContentLibraryService) => Promise<T>) =>
  withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new ContentLibraryService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
        }),
      ),
    { prisma: app },
  );

const calendar = <T>(fn: (s: ContentCalendarService) => Promise<T>) =>
  withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new ContentCalendarService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          timezone: 'UTC',
          // This suite only READS the month view, so the quota is never
          // consumed. A throwing stub makes that explicit: if a future
          // assertion schedules something here, it fails loudly rather than
          // silently spending a real workspace's quota.
          quota: {
            limit: async () => null,
            consume: async () => {
              throw new Error('this suite does not schedule');
            },
            refund: async () => {
              throw new Error('this suite does not schedule');
            },
          },
        }),
      ),
    { prisma: app },
  );

describe('listItems applies BrandScope inside the query', () => {
  it('an empty scope is UNRESTRICTED, matching the platform rule', async () => {
    const all = await library((s) => s.listItems({ status: 'DRAFT', brandScope: [] }));
    expect(all.length).toBeGreaterThanOrEqual(NOISE);
  });

  it('a non-empty scope returns only that brand', async () => {
    const scoped = await library((s) =>
      s.listItems({ status: 'DRAFT', brandScope: [otherBrandId] }),
    );
    expect(scoped.length).toBe(NOISE);
    expect(scoped.every((i) => i.brandId === otherBrandId)).toBe(true);
  });

  it('THE TRUNCATION BUG: a small limit still returns the in-scope rows', async () => {
    /*
     * THE ASSERTION THAT WOULD HAVE FAILED BEFORE THE FIX.
     *
     * With `limit` smaller than the number of out-of-scope drafts, a caller
     * that filtered AFTER the query got an empty list — the database had
     * already spent the whole page on brands the member cannot see. Applying
     * the scope in the query means the limit is spent on rows that count.
     */
    const limit = 3;

    // The whole page, unscoped, is spent on the newer out-of-scope brand —
    // this is what the caller used to receive before filtering in JavaScript.
    const unscopedPage = await library((s) => s.listItems({ status: 'DRAFT', limit }));
    expect(unscopedPage.length).toBe(limit);
    expect(
      unscopedPage.every((i) => i.brandId === otherBrandId),
      'the fixture must make the newest drafts out-of-scope for this to be the bug',
    ).toBe(true);

    // Scoped in the QUERY, the same limit finds the member's own draft.
    // Filtering `unscopedPage` by brand would have produced an empty list and
    // told a scoped member they had nothing to schedule.
    const scoped = await library((s) =>
      s.listItems({ status: 'DRAFT', limit, brandScope: [fixtures.a.brandId] }),
    );
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((i) => i.brandId === fixtures.a.brandId)).toBe(true);
    expect(scoped.some((i) => i.title === 'In-scope draft')).toBe(true);
  });
});

describe('the calendar month view applies BrandScope inside the query', () => {
  it('accepts a scope and never returns a brand outside it', async () => {
    const now = new Date();
    const views = await calendar((s) =>
      s.monthView({
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
        brandScope: [otherBrandId],
      }),
    );
    expect(views.every((v) => v.slot.brandId === otherBrandId)).toBe(true);
  });

  it('an empty scope is UNRESTRICTED here too', async () => {
    const now = new Date();
    const unrestricted = await calendar((s) =>
      s.monthView({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, brandScope: [] }),
    );
    const noScopeArgument = await calendar((s) =>
      s.monthView({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }),
    );
    expect(unrestricted.length).toBe(noScopeArgument.length);
  });
});

// ---------------------------------------------------------------------------
// The intersection matrix. An explicit brand filter and the authorization
// scope must AND together — neither may replace the other.
// ---------------------------------------------------------------------------

describe('an explicit brandId INTERSECTS the BrandScope, never overwrites it', () => {
  /*
   * THE DEFECT THIS PINS, because it was introduced by the very change that
   * made scope a query predicate:
   *
   *     ...(input.brandId ? { brandId: input.brandId } : {}),
   *     ...brandIdScopeFilter(input.brandScope),
   *
   * Both fragments set `brandId`, and in an object literal the LATER one wins.
   * So a non-empty scope silently REPLACED the caller's explicit brand: asking
   * for brand A while scoped to [A, B] returned A *and* B. That is the same
   * "later key wins" defect the Activity Log was corrected for, reintroduced
   * one milestone later. `brandIdQueryFilter` can only produce an `AND`.
   */
  const bothBrands = () => [fixtures.a.brandId, otherBrandId];

  it('no brandId + scope [other] => only other', async () => {
    const rows = await library((s) => s.listItems({ status: 'DRAFT', brandScope: [otherBrandId] }));
    expect(rows.length).toBe(NOISE);
    expect(rows.every((i) => i.brandId === otherBrandId)).toBe(true);
  });

  it('brandId A + scope [A, other] => ONLY A — the case that used to leak', async () => {
    const rows = await library((s) =>
      s.listItems({ status: 'DRAFT', brandId: fixtures.a.brandId, brandScope: bothBrands() }),
    );
    expect(rows.every((i) => i.brandId === fixtures.a.brandId)).toBe(true);
    expect(rows.some((i) => i.brandId === otherBrandId)).toBe(false);
  });

  it('brandId other + scope [A, other] => only other', async () => {
    const rows = await library((s) =>
      s.listItems({ status: 'DRAFT', brandId: otherBrandId, brandScope: bothBrands() }),
    );
    expect(rows.length).toBe(NOISE);
    expect(rows.every((i) => i.brandId === otherBrandId)).toBe(true);
  });

  it('brandId OUTSIDE the scope => empty, and says nothing about that brand', async () => {
    const outside = randomUUID();
    const rows = await library((s) =>
      s.listItems({ status: 'DRAFT', brandId: outside, brandScope: [fixtures.a.brandId] }),
    );
    expect(rows).toEqual([]);
  });

  it('empty scope + brandId other => only other (scope contributes nothing)', async () => {
    const rows = await library((s) =>
      s.listItems({ status: 'DRAFT', brandId: otherBrandId, brandScope: [] }),
    );
    expect(rows.length).toBe(NOISE);
    expect(rows.every((i) => i.brandId === otherBrandId)).toBe(true);
  });

  it('empty scope + no brandId => unrestricted within the workspace', async () => {
    const rows = await library((s) => s.listItems({ status: 'DRAFT', brandScope: [] }));
    expect(rows.some((i) => i.brandId === otherBrandId)).toBe(true);
    expect(rows.some((i) => i.brandId === fixtures.a.brandId)).toBe(true);
  });

  it('the calendar obeys the same matrix', async () => {
    const now = new Date();
    const month = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
    const scopedToA = await calendar((s) =>
      s.monthView({ ...month, brandId: fixtures.a.brandId, brandScope: bothBrands() }),
    );
    expect(scopedToA.every((v) => v.slot.brandId === fixtures.a.brandId)).toBe(true);

    const outside = await calendar((s) =>
      s.monthView({ ...month, brandId: randomUUID(), brandScope: [fixtures.a.brandId] }),
    );
    expect(outside).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Counts and single-item reads are scoped too.
// ---------------------------------------------------------------------------

describe('counts and item reads apply BrandScope in the query', () => {
  it('A COUNT IS A DISCLOSURE: status tabs never count another brand', async () => {
    const scoped = await library((s) => s.countsByStatus({ brandScope: [fixtures.a.brandId] }));
    const unrestricted = await library((s) => s.countsByStatus({ brandScope: [] }));
    expect(unrestricted['DRAFT'] ?? 0).toBeGreaterThan(scoped['DRAFT'] ?? 0);
    expect(scoped['DRAFT'] ?? 0).toBeGreaterThan(0);
  });

  it('countsByStatus intersects an explicit brand with the scope', async () => {
    const both = [fixtures.a.brandId, otherBrandId];
    const counts = await library((s) =>
      s.countsByStatus({ brandId: fixtures.a.brandId, brandScope: both }),
    );
    const onlyA = await library((s) => s.countsByStatus({ brandScope: [fixtures.a.brandId] }));
    expect(counts['DRAFT'] ?? 0).toBe(onlyA['DRAFT'] ?? 0);
  });

  it('getItem refuses an out-of-scope draft in the QUERY, not afterwards', async () => {
    const noise = await library((s) =>
      s.listItems({ status: 'DRAFT', brandScope: [otherBrandId], limit: 1 }),
    );
    const foreignItemId = noise[0]?.id;
    expect(foreignItemId, 'the fixture should provide an out-of-scope draft').toBeTruthy();

    // Unrestricted: found.
    await expect(library((s) => s.getItem(foreignItemId as string, []))).resolves.toBeTruthy();
    // Scoped elsewhere: NOT FOUND, exactly as a draft that never existed.
    await expect(
      library((s) => s.getItem(foreignItemId as string, [fixtures.a.brandId])),
    ).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// The MUTATION paths — D-132's second half.
// ---------------------------------------------------------------------------

/**
 * A client that records the `where` of every read it is asked to perform.
 *
 * WHY A RECORDER AND NOT JUST AN ASSERTION ON THE OUTCOME. These four paths
 * load a row the caller is about to CHANGE, and the post-read form they used to
 * have threw the very same not-found: `assertBrandInScope` was written for
 * exactly that (F-74). So an outcome-only test passes against the defect and
 * proves nothing. What actually changed is WHERE the authorization lives — in
 * the predicate, so the out-of-scope row is never retrieved at all — and the
 * only way to assert that is to look at the query that was issued.
 *
 * Against the previous `findUnique({ where: { id } })`, every assertion below
 * fails: the recorded `where` carries an id and nothing else.
 */
interface RecordedRead {
  readonly model: string;
  readonly op: string;
  readonly where: Record<string, unknown> | undefined;
}

const WATCHED = ['contentItem', 'contentVariant', 'calendarSlot'] as const;

function recordingClient<T extends object>(db: T, into: RecordedRead[]): T {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof prop !== 'string' || !(WATCHED as readonly string[]).includes(prop)) return value;
      return new Proxy(value as object, {
        get(model, op) {
          const fn = Reflect.get(model, op) as unknown;
          if (typeof op !== 'string' || typeof fn !== 'function' || !op.startsWith('find')) {
            return fn;
          }
          return (args: { where?: Record<string, unknown> }) => {
            into.push({ model: prop, op, where: args?.where });
            return (fn as (a: unknown) => unknown)(args);
          };
        },
      });
    },
  }) as T;
}

/** Does this `where` constrain `brandId`, at the top level or inside an AND? */
function constrainsBrand(where: Record<string, unknown> | undefined): boolean {
  if (!where) return false;
  if ('brandId' in where) return true;
  const and = where['AND'];
  return Array.isArray(and) && and.some((c) => c && typeof c === 'object' && 'brandId' in c);
}

const watchedLibrary = <T>(fn: (s: ContentLibraryService) => Promise<T>) => {
  const reads: RecordedRead[] = [];
  const done = withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new ContentLibraryService({
          db: recordingClient(db as object, reads) as typeof db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
        }),
      ),
    { prisma: app },
  );
  return { reads, done };
};

const watchedCalendar = <T>(fn: (s: ContentCalendarService) => Promise<T>) => {
  const reads: RecordedRead[] = [];
  const done = withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new ContentCalendarService({
          db: recordingClient(db as object, reads) as typeof db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          timezone: 'UTC',
          quota: {
            limit: async () => null,
            consume: async () => {
              throw new Error('this suite does not schedule');
            },
            refund: async () => {
              throw new Error('this suite does not schedule');
            },
          },
        }),
      ),
    { prisma: app },
  );
  return { reads, done };
};

/** `YYYY-MM-DDTHH:mm` in the workspace's zone (UTC here), N days out. */
function futureLocalTime(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 16);
}

describe('the mutation paths carry BrandScope in the query, not after it', () => {
  /** Everything in `fixtures.a` belongs to brand A, so this scope excludes it. */
  const elsewhere = () => [otherBrandId];

  it('transition: the item lookup is SCOPED, and an out-of-scope item is not found', async () => {
    const { reads, done } = watchedLibrary((s) =>
      s.transition({
        itemId: fixtures.a.contentItemId,
        to: 'ARCHIVED',
        actorUserId: fixtures.a.userId,
        actorBrandScope: elsewhere(),
      }),
    );
    await expect(done).rejects.toThrow(/not found/i);

    const lookup = reads.find((r) => r.model === 'contentItem');
    expect(lookup, 'transition must read the item it is about to change').toBeTruthy();
    expect(
      constrainsBrand(lookup?.where),
      'the scope must be part of the WHERE, not applied after the row is fetched',
    ).toBe(true);
  });

  it('editVariant: the variant lookup is SCOPED', async () => {
    const { reads, done } = watchedLibrary((s) =>
      s.editVariant({
        variantId: fixtures.a.contentVariantId,
        body: 'Should never be written.',
        actorUserId: fixtures.a.userId,
        actorBrandScope: elsewhere(),
      }),
    );
    await expect(done).rejects.toThrow(/not found/i);

    const lookup = reads.find((r) => r.model === 'contentVariant');
    expect(lookup, 'editVariant must read the variant it is about to change').toBeTruthy();
    expect(constrainsBrand(lookup?.where)).toBe(true);
  });

  it('schedule: the item lookup is SCOPED, and refuses before any quota is touched', async () => {
    const { reads, done } = watchedCalendar((s) =>
      s.schedule({
        contentItemId: fixtures.a.contentItemId,
        localTime: futureLocalTime(1),
        actorUserId: fixtures.a.userId,
        actorBrandScope: elsewhere(),
      }),
    );
    // The quota stub throws if consumed, so reaching it would surface here as a
    // different error entirely.
    await expect(done).rejects.toThrow(/not found/i);

    const lookup = reads.find((r) => r.model === 'contentItem');
    expect(lookup).toBeTruthy();
    expect(constrainsBrand(lookup?.where)).toBe(true);
  });

  it('cancel: the slot lookup is SCOPED', async () => {
    const { reads, done } = watchedCalendar((s) =>
      s.cancel({
        slotId: fixtures.a.calendarSlotId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: elsewhere(),
      }),
    );
    await expect(done).rejects.toThrow(/not found/i);

    const lookup = reads.find((r) => r.model === 'calendarSlot');
    expect(lookup, 'cancel must read the slot it is about to change').toBeTruthy();
    expect(constrainsBrand(lookup?.where)).toBe(true);
  });

  it('reschedule: the slot lookup is SCOPED', async () => {
    const { reads, done } = watchedCalendar((s) =>
      s.reschedule({
        slotId: fixtures.a.calendarSlotId,
        localTime: futureLocalTime(2),
        actorUserId: fixtures.a.userId,
        actorBrandScope: elsewhere(),
      }),
    );
    await expect(done).rejects.toThrow(/not found/i);

    const lookup = reads.find((r) => r.model === 'calendarSlot');
    expect(lookup).toBeTruthy();
    expect(constrainsBrand(lookup?.where)).toBe(true);
  });

  it('a REAL out-of-scope id and a FABRICATED one are refused identically', async () => {
    const message = async (id: string) => {
      try {
        await watchedLibrary((s) =>
          s.transition({
            itemId: id,
            to: 'ARCHIVED',
            actorUserId: fixtures.a.userId,
            actorBrandScope: elsewhere(),
          }),
        ).done;
      } catch (error) {
        const e = error as { code?: unknown; message?: unknown };
        return `${String(e.code)}:${String(e.message)}`;
      }
      throw new Error('the mutation was ACCEPTED');
    };
    expect(await message(fixtures.a.contentItemId)).toEqual(await message(randomUUID()));
  });

  it('an EMPTY scope stays UNRESTRICTED, and a same-brand edit still succeeds', async () => {
    /*
     * The other half of the platform rule, and the regression this change could
     * plausibly have caused: pushing the predicate down must not turn "no
     * restriction" into "matches nothing".
     */
    const variant = await withWorkspace(
      fixtures.a.workspaceId,
      (db) => db.contentVariant.findUniqueOrThrow({ where: { id: fixtures.a.contentVariantId } }),
      { prisma: app },
    );

    const unrestricted = watchedLibrary((s) =>
      s.editVariant({
        variantId: fixtures.a.contentVariantId,
        body: variant.body ?? '',
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      }),
    );
    await expect(unrestricted.done).resolves.toBeTruthy();
    expect(
      constrainsBrand(unrestricted.reads.find((r) => r.model === 'contentVariant')?.where),
      'an empty scope must add NO brand predicate at all',
    ).toBe(false);

    // And the caller's OWN brand is still a successful edit, not a refusal.
    const inScope = watchedLibrary((s) =>
      s.editVariant({
        variantId: fixtures.a.contentVariantId,
        body: variant.body ?? '',
        actorUserId: fixtures.a.userId,
        actorBrandScope: [fixtures.a.brandId],
      }),
    );
    await expect(inScope.done).resolves.toBeTruthy();
  });
});
