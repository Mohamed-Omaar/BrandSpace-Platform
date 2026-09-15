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
