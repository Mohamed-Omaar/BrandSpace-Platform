import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { ProviderRateLimiter } from '@brandspace/social-connectors';
import {
  AnalyticsExportService,
  AnalyticsIngestionService,
  AnalyticsQueryService,
  createAnalyticsRegistry,
  ensureIngestionCursors,
  observationKeyFor,
  parseAnalyticsPolicy,
  upsertObservations,
  type AnalyticsPolicy,
  type ObservationInput,
} from '@brandspace/analytics';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Phase 7 — the analytics SERVICES, against real PostgreSQL.
 *
 * The tenancy suites prove the database refuses a foreign row. This one proves
 * the three things the services themselves are responsible for, and each has a
 * defect it exists to prevent:
 *
 *  1. BRANDSCOPE IS A QUERY PREDICATE (D-132, D-134), NOT A POST-READ FILTER. A
 *     service that read every brand's rows and then dropped the ones the caller
 *     may not see would be correct on screen and wrong everywhere it mattered —
 *     the total, the export, the evidence package. So the assertions here are
 *     about AGGREGATES and EXPORT ROW COUNTS, which a post-read filter cannot
 *     fake.
 *
 *  2. AN EXPORT CARRIES ZERO FOREIGN ROWS, and no formula. Both are checked
 *     against the file's actual bytes rather than against the query.
 *
 *  3. CONCURRENCY IS A PROPERTY OF THE STATEMENT. Two writers converging on one
 *     observation, two schedulers claiming one cursor, a redelivery carrying a
 *     stale reading: all three are run for real, in parallel, and asserted on
 *     what the database ended up holding.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AnalyticsPolicy;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAnalyticsPolicy(defaultPayload('analytics'));
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const PERIOD = {
  start: new Date('2026-08-01T00:00:00.000Z'),
  end: new Date('2026-10-01T00:00:00.000Z'),
};

function queries(db: TenantScopedClient, workspaceId: string): AnalyticsQueryService {
  return new AnalyticsQueryService({
    db,
    workspaceId,
    policy,
    registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
  });
}

function exports_(db: TenantScopedClient, workspaceId: string): AnalyticsExportService {
  return new AnalyticsExportService({ db, workspaceId, policy });
}

describe('BrandScope is a query predicate, not a post-read filter (D-132/D-134)', () => {
  it("a summary scoped to A's brand never sums B's observations", async () => {
    const summary = await inA((db) =>
      queries(db, fixtures.a.workspaceId).summary({
        scope: { brandId: fixtures.a.brandId },
        period: PERIOD,
        brandScope: [fixtures.a.brandId],
        metricKeys: ['impressions'],
      }),
    );
    const impressions = summary.metrics.find((m) => m.metricKey === 'impressions');

    const own = await inA((db) =>
      db.metricObservation.aggregate({
        where: { brandId: fixtures.a.brandId, metricKey: 'impressions' },
        _sum: { value: true },
      }),
    );
    expect(impressions?.value).toBe(own._sum.value);

    // And it is a DIFFERENT number from the one a boundary crossing would give.
    const other = await inB((db) =>
      db.metricObservation.aggregate({
        where: { metricKey: 'impressions' },
        _sum: { value: true },
      }),
    );
    expect(impressions?.value).not.toBe((own._sum.value ?? 0n) + (other._sum.value ?? 0n));
  });

  it("naming B's brand id is refused BEFORE any query runs, not filtered afterwards", async () => {
    await expect(
      inA((db) =>
        queries(db, fixtures.a.workspaceId).summary({
          scope: { brandId: fixtures.b.brandId },
          period: PERIOD,
          brandScope: [fixtures.a.brandId],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("a scope naming ANOTHER of A's OWN brands excludes the first brand's rows from the TOTAL", async () => {
    /*
     * THE ASSERTION A POST-READ FILTER CANNOT FAKE, inside one workspace where
     * RLS is no help at all. A second brand is created in A with its own
     * observation; a summary scoped to that second brand must return ITS total,
     * not the workspace's. Comparing totals rather than row lists is deliberate:
     * a service that read both brands and dropped one afterwards would still
     * produce the right list and the wrong number.
     */
    const second = await inA((db) =>
      db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `second-${randomUUID().slice(0, 8)}`,
          name: 'Second Brand',
        },
      }),
    );
    const periodStart = new Date('2026-09-20T00:00:00.000Z');
    await inA((db) =>
      db.metricObservation.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: second.id,
          socialConnectionId: fixtures.a.socialConnectionId,
          provider: 'LINKEDIN',
          subjectType: 'ACCOUNT',
          subjectExternalId: `second-account-${randomUUID().slice(0, 8)}`,
          metricKey: 'impressions',
          granularity: 'DAY',
          periodStart,
          periodEnd: new Date('2026-09-21T00:00:00.000Z'),
          value: 7n,
          unit: 'COUNT',
          observedAt: new Date('2026-09-21T00:00:00.000Z'),
          sourceKind: 'PROVIDER',
          sourceVersion: 'scope-probe-1',
          observationKey: `scope-${randomUUID()}`,
        },
      }),
    );

    const scoped = await inA((db) =>
      queries(db, fixtures.a.workspaceId).summary({
        scope: {},
        period: PERIOD,
        brandScope: [second.id],
        metricKeys: ['impressions'],
      }),
    );
    expect(scoped.metrics.find((m) => m.metricKey === 'impressions')?.value).toBe(7n);

    /*
     * AND THE DOCUMENTED SEMANTICS OF AN EMPTY SCOPE: unrestricted WITHIN THE
     * WORKSPACE, never across it. So the unscoped total must be strictly larger
     * than the scoped one — and still only A's.
     */
    const unscoped = await inA((db) =>
      queries(db, fixtures.a.workspaceId).summary({
        scope: {},
        period: PERIOD,
        brandScope: [],
        metricKeys: ['impressions'],
      }),
    );
    const total = unscoped.metrics.find((m) => m.metricKey === 'impressions')?.value ?? 0n;
    expect(total).toBeGreaterThan(7n);

    const workspaceTotal = await inA((db) =>
      db.metricObservation.aggregate({
        where: { metricKey: 'impressions' },
        _sum: { value: true },
      }),
    );
    expect(total).toBe(workspaceTotal._sum.value);
  });

  it("a series scoped to another brand shows that brand's points, not the workspace's", async () => {
    const other = await inA((db) =>
      db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `series-${randomUUID().slice(0, 8)}`,
          name: 'Series Brand',
        },
      }),
    );
    const series = await inA((db) =>
      queries(db, fixtures.a.workspaceId).series({
        scope: {},
        period: PERIOD,
        metricKey: 'impressions',
        brandScope: [other.id],
      }),
    );
    // A brand with no observations has GAPS, never zeros.
    expect(series.points.every((point) => point.value === null)).toBe(true);
  });

  it('missing is not zero: an unmeasured metric is null with a stated reason', async () => {
    const summary = await inA((db) =>
      queries(db, fixtures.a.workspaceId).summary({
        scope: { brandId: fixtures.a.brandId },
        period: {
          start: new Date('2020-01-01T00:00:00.000Z'),
          end: new Date('2020-01-08T00:00:00.000Z'),
        },
        brandScope: [fixtures.a.brandId],
        metricKeys: ['impressions'],
      }),
    );
    const impressions = summary.metrics.find((m) => m.metricKey === 'impressions');
    expect(impressions?.value).toBeNull();
    expect(impressions?.absent).not.toBeNull();
    expect(impressions?.observationCount).toBe(0);
  });
});

describe('the CSV export leaks nothing', () => {
  it("contains A's rows and ZERO of B's, counted in the file itself", async () => {
    const result = await inA((db) =>
      exports_(db, fixtures.a.workspaceId).toCsv({
        scope: {},
        period: PERIOD,
        brandScope: [fixtures.a.brandId],
        actorUserId: fixtures.a.userId,
      }),
    );

    expect(result.rowCount).toBeGreaterThan(0);
    expect(result.csv).toContain(`Fixture Organization ${fixtures.a.slug}`);
    /*
     * THE ASSERTION ON THE BYTES. Not "the query was scoped" — the file does not
     * mention the other tenant's account, brand, slug, workspace or row ids
     * anywhere in it. `slug` is the discriminator every fixture row carries, so
     * one crossing of the boundary would put it in the file.
     */
    expect(result.csv).not.toContain(fixtures.b.slug);
    expect(result.csv).not.toContain(fixtures.b.socialExternalAccountId);
    expect(result.csv).not.toContain(fixtures.b.workspaceId);
    expect(result.csv).not.toContain(fixtures.b.metricObservationId);
  });

  it('carries no internal identifiers at all — not even its own', async () => {
    const result = await inA((db) =>
      exports_(db, fixtures.a.workspaceId).toCsv({
        scope: {},
        period: PERIOD,
        brandScope: [fixtures.a.brandId],
        actorUserId: fixtures.a.userId,
      }),
    );
    expect(result.csv).not.toContain(fixtures.a.metricObservationId);
    expect(result.csv).not.toContain(fixtures.a.metricObservationKey);
    expect(result.csv).not.toContain(fixtures.a.workspaceId);
  });

  it('de-fangs a provider-supplied name that starts with a formula character', () => {
    /*
     * THE SPREADSHEET ATTACK, END TO END. A connected account's DISPLAY NAME is
     * provider-supplied text that reaches a cell, and a name beginning `=` is
     * executed by Excel, Numbers and Sheets unless the cell is guarded. The
     * connection is created here rather than in the shared fixtures because a
     * hostile display name has no business in every other suite's data.
     */
    return (async () => {
      const connection = await inA((db) =>
        db.socialConnection.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            provider: 'X',
            externalAccountId: `formula-${randomUUID().slice(0, 8)}`,
            displayName: '=HYPERLINK("https://evil.invalid","claim")',
            targetKind: 'profile',
            status: 'ACTIVE',
          },
        }),
      );

      await inA((db) =>
        db.metricObservation.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            socialConnectionId: connection.id,
            provider: 'X',
            subjectType: 'ACCOUNT',
            subjectExternalId: connection.externalAccountId,
            metricKey: 'impressions',
            granularity: 'DAY',
            periodStart: new Date('2026-09-10T00:00:00.000Z'),
            periodEnd: new Date('2026-09-11T00:00:00.000Z'),
            value: 5n,
            unit: 'COUNT',
            observedAt: new Date('2026-09-11T00:00:00.000Z'),
            sourceKind: 'PROVIDER',
            sourceVersion: 'probe-1',
            observationKey: `formula-${randomUUID()}`,
          },
        }),
      );

      const result = await inA((db) =>
        exports_(db, fixtures.a.workspaceId).toCsv({
          scope: {},
          period: PERIOD,
          brandScope: [fixtures.a.brandId],
          actorUserId: fixtures.a.userId,
        }),
      );
      expect(result.csv).toContain(`"'=HYPERLINK`);
      expect(result.csv).not.toContain(`"=HYPERLINK`);
    })();
  });

  it('refuses an out-of-scope brand rather than exporting an empty file', async () => {
    await expect(
      inA((db) =>
        exports_(db, fixtures.a.workspaceId).toCsv({
          scope: { brandId: fixtures.b.brandId },
          period: PERIOD,
          brandScope: [fixtures.a.brandId],
          actorUserId: fixtures.a.userId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('ingestion survives concurrency, duplicate delivery and out-of-order arrival', () => {
  function reading(periodStart: Date, value: bigint, observedAt: Date): ObservationInput {
    return {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      socialConnectionId: fixtures.a.socialConnectionId,
      provider: 'LINKEDIN',
      subjectType: 'ACCOUNT',
      subjectExternalId: fixtures.a.socialExternalAccountId,
      publishJobId: null,
      contentItemId: null,
      metricKey: 'reach',
      granularity: 'DAY',
      periodStart,
      periodEnd: new Date(periodStart.getTime() + 24 * 60 * 60 * 1_000),
      value,
      unit: 'COUNT',
      observedAt,
      sourceKind: 'PROVIDER',
      sourceVersion: 'concurrency-probe-1',
      ingestionRunId: null,
    };
  }

  it('two writers converging on the same observation produce exactly one row', async () => {
    const periodStart = new Date('2026-07-01T00:00:00.000Z');
    const observedAt = new Date('2026-07-02T00:00:00.000Z');
    const row = reading(periodStart, 100n, observedAt);

    /*
     * BOTH WRITES ARE IN FLIGHT AT ONCE. This is the duplicate scheduler and the
     * duplicate queue delivery at the same time, and the only thing standing
     * between them is `ON CONFLICT` — a "check then insert" loses here every
     * time, because the gap between the check and the insert is where the other
     * writer is.
     */
    await Promise.all([
      inA((db) => upsertObservations(db, fixtures.a.workspaceId, [row])),
      inA((db) => upsertObservations(db, fixtures.a.workspaceId, [row])),
    ]);

    const key = observationKeyFor({
      workspaceId: fixtures.a.workspaceId,
      socialConnectionId: fixtures.a.socialConnectionId,
      subjectType: 'ACCOUNT',
      subjectExternalId: fixtures.a.socialExternalAccountId,
      metricKey: 'reach',
      granularity: 'DAY',
      periodStart,
    });
    const rows = await inA((db) =>
      db.metricObservation.findMany({ where: { observationKey: key } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(100n);
  });

  it('a re-fetch of the same window does not create a second row', async () => {
    /*
     * WHAT "IDEMPOTENT" MEANS HERE, stated precisely rather than loosely. A
     * re-fetch carrying the SAME `observedAt` is allowed to land — that is what
     * makes a platform's silent correction of an already-fetched figure
     * reachable, and the mock adapter derives `observedAt` from the window, so
     * every honest re-fetch has exactly this shape. What must never happen is a
     * SECOND ROW for the same measurement, and that is what is asserted.
     */
    const periodStart = new Date('2026-07-03T00:00:00.000Z');
    const observedAt = new Date('2026-07-04T00:00:00.000Z');
    const row = reading(periodStart, 50n, observedAt);

    const first = await inA((db) => upsertObservations(db, fixtures.a.workspaceId, [row]));
    await inA((db) => upsertObservations(db, fixtures.a.workspaceId, [row]));
    expect(first.written).toBe(1);

    const key = observationKeyFor({
      workspaceId: fixtures.a.workspaceId,
      socialConnectionId: fixtures.a.socialConnectionId,
      subjectType: 'ACCOUNT',
      subjectExternalId: fixtures.a.socialExternalAccountId,
      metricKey: 'reach',
      granularity: 'DAY',
      periodStart,
    });
    const rows = await inA((db) =>
      db.metricObservation.findMany({ where: { observationKey: key } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(50n);
  });

  it("a platform's revision of yesterday's figure DOES land", async () => {
    const periodStart = new Date('2026-07-05T00:00:00.000Z');
    await inA((db) =>
      upsertObservations(db, fixtures.a.workspaceId, [
        reading(periodStart, 10n, new Date('2026-07-06T00:00:00.000Z')),
      ]),
    );
    await inA((db) =>
      upsertObservations(db, fixtures.a.workspaceId, [
        reading(periodStart, 17n, new Date('2026-07-07T00:00:00.000Z')),
      ]),
    );

    const key = observationKeyFor({
      workspaceId: fixtures.a.workspaceId,
      socialConnectionId: fixtures.a.socialConnectionId,
      subjectType: 'ACCOUNT',
      subjectExternalId: fixtures.a.socialExternalAccountId,
      metricKey: 'reach',
      granularity: 'DAY',
      periodStart,
    });
    const stored = await inA((db) =>
      db.metricObservation.findFirstOrThrow({ where: { observationKey: key } }),
    );
    expect(stored.value).toBe(17n);
  });

  it('a LATE redelivery carrying an older reading does NOT roll the figure backwards', async () => {
    const periodStart = new Date('2026-07-08T00:00:00.000Z');
    await inA((db) =>
      upsertObservations(db, fixtures.a.workspaceId, [
        reading(periodStart, 900n, new Date('2026-07-12T00:00:00.000Z')),
      ]),
    );
    // The stale message finally arrives, minutes after the fresher pull.
    const stale = await inA((db) =>
      upsertObservations(db, fixtures.a.workspaceId, [
        reading(periodStart, 3n, new Date('2026-07-09T00:00:00.000Z')),
      ]),
    );
    // Reported as UNCHANGED rather than written — the refusal is visible, not silent.
    expect(stale.written).toBe(0);
    expect(stale.unchanged).toBe(1);

    const key = observationKeyFor({
      workspaceId: fixtures.a.workspaceId,
      socialConnectionId: fixtures.a.socialConnectionId,
      subjectType: 'ACCOUNT',
      subjectExternalId: fixtures.a.socialExternalAccountId,
      metricKey: 'reach',
      granularity: 'DAY',
      periodStart,
    });
    const stored = await inA((db) =>
      db.metricObservation.findFirstOrThrow({ where: { observationKey: key } }),
    );
    expect(stored.value).toBe(900n);
  });

  it('an upsert cannot smuggle a row into another workspace', async () => {
    await expect(
      inA((db) =>
        upsertObservations(db, fixtures.a.workspaceId, [
          {
            ...reading(new Date('2026-07-20T00:00:00.000Z'), 1n, new Date()),
            brandId: fixtures.b.brandId,
          },
        ]),
      ),
    ).rejects.toThrow();
  });
});

describe('two schedulers cannot claim the same cursor', () => {
  function ingestion(db: TenantScopedClient, workspaceId: string): AnalyticsIngestionService {
    return new AnalyticsIngestionService({
      db,
      workspaceId,
      policy,
      registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
      credentials: { resolve: async () => null },
      rateLimiter: new ProviderRateLimiter({ clock: { now: () => new Date() } }),
    });
  }

  it('a claim is exclusive: the same cursor is returned to exactly one caller', async () => {
    // Make A's cursor due right now, and unclaimed.
    await inA((db) =>
      db.analyticsIngestionCursor.update({
        where: { id: fixtures.a.analyticsCursorId },
        data: { nextAttemptAt: new Date(Date.now() - 60_000), claimedAt: null },
      }),
    );

    const [first, second] = await Promise.all([
      inA((db) => ingestion(db, fixtures.a.workspaceId).claimDueCursors(10)),
      inA((db) => ingestion(db, fixtures.a.workspaceId).claimDueCursors(10)),
    ]);

    const claimedTwice = [...first, ...second]
      .map((row) => row.id)
      .filter((id) => id === fixtures.a.analyticsCursorId);
    expect(claimedTwice).toHaveLength(1);
  });

  it("a sweep in A never claims B's cursor, however due it is", async () => {
    await inB((db) =>
      db.analyticsIngestionCursor.update({
        where: { id: fixtures.b.analyticsCursorId },
        data: { nextAttemptAt: new Date(Date.now() - 600_000), claimedAt: null },
      }),
    );

    const claimed = await inA((db) => ingestion(db, fixtures.a.workspaceId).claimDueCursors(50));
    expect(claimed.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(claimed.some((row) => row.id === fixtures.b.analyticsCursorId)).toBe(false);

    const untouched = await inB((db) =>
      db.analyticsIngestionCursor.findFirstOrThrow({
        where: { id: fixtures.b.analyticsCursorId },
        select: { claimedAt: true },
      }),
    );
    expect(untouched.claimedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('CURSORS ARE ACTUALLY CREATED FOR CONNECTED ACCOUNTS (PHASE 2)', () => {
  /*
   * THE DEFECT THIS SUITE EXISTS FOR.
   *
   * `ensureCursors` was written, correct, and had NO CALLER anywhere in the
   * repository. No `analytics_ingestion_cursor` row was therefore ever created
   * in the product, and the scheduler's analytics sweep — which enumerates
   * cursors that are DUE and dispatches a message for each — enumerated an
   * empty set on every tick. Analytics ingestion never ran at all: a module
   * complete down to its retry backoff, with no way in.
   *
   * These tests drive the standalone `ensureIngestionCursors` that the
   * scheduler now calls, against real PostgreSQL and the real registry.
   */

  const registry = createAnalyticsRegistry({ environment: 'DEVELOPMENT' });

  async function cursorCount(workspaceId: string): Promise<number> {
    return withWorkspace(
      workspaceId,
      async (db) => db.analyticsIngestionCursor.count({ where: { workspaceId } }),
      { prisma: app },
    ) as Promise<number>;
  }

  it('CREATES CURSORS FOR AN ACTIVE CONNECTION THAT HAS NONE', async () => {
    const workspaceId = fixtures.a.workspaceId;
    // Start from nothing, so "created" is measured rather than assumed.
    await withWorkspace(
      workspaceId,
      async (db) => db.analyticsIngestionCursor.deleteMany({ where: { workspaceId } }),
      { prisma: app },
    );
    expect(await cursorCount(workspaceId)).toBe(0);

    const result = (await withWorkspace(
      workspaceId,
      async (db) => ensureIngestionCursors({ db, workspaceId, registry }),
      { prisma: app },
    )) as { created: number };

    expect(result.created).toBeGreaterThan(0);
    expect(await cursorCount(workspaceId)).toBe(result.created);

    // AND THEY POINT AT THE ACTIVE CONNECTION, with a granularity the adapter
    // actually supports — never LIFETIME, which is a running total rather than
    // a window and would make a cursor that walked nothing.
    const rows = await withWorkspace(
      workspaceId,
      async (db) =>
        db.analyticsIngestionCursor.findMany({
          where: { workspaceId },
          select: { socialConnectionId: true, granularity: true, freshness: true },
        }),
      { prisma: app },
    );
    /*
     * COVERS THE FIXTURE CONNECTION — and not ONLY it. Another suite in this
     * file creates a second ACTIVE connection for the same workspace, and
     * cursors for that one are correct rather than a leak: the pass is supposed
     * to cover every active connection it finds.
     */
    expect(rows.some((r) => r.socialConnectionId === fixtures.a.socialConnectionId)).toBe(true);
    expect(rows.some((r) => r.granularity === 'LIFETIME')).toBe(false);
    expect(rows.every((r) => r.freshness === 'UNAVAILABLE')).toBe(true);
  });

  it('IS IDEMPOTENT — a second pass creates nothing and resets no progress', async () => {
    const workspaceId = fixtures.a.workspaceId;
    await withWorkspace(
      workspaceId,
      async (db) => ensureIngestionCursors({ db, workspaceId, registry }),
      { prisma: app },
    );
    const before = await cursorCount(workspaceId);

    // Give one cursor some progress, which a housekeeping pass must not undo.
    const moved = new Date('2026-09-01T00:00:00.000Z');
    await withWorkspace(
      workspaceId,
      async (db) =>
        db.analyticsIngestionCursor.updateMany({
          where: { workspaceId },
          data: { lastCoveredPeriodEnd: moved, consecutiveFailureCount: 3 },
        }),
      { prisma: app },
    );

    const again = (await withWorkspace(
      workspaceId,
      async (db) => ensureIngestionCursors({ db, workspaceId, registry }),
      { prisma: app },
    )) as { created: number };

    expect(again.created).toBe(0);
    expect(await cursorCount(workspaceId)).toBe(before);

    const kept = await withWorkspace(
      workspaceId,
      async (db) =>
        db.analyticsIngestionCursor.findFirst({
          where: { workspaceId },
          select: { lastCoveredPeriodEnd: true, consecutiveFailureCount: true },
        }),
      { prisma: app },
    );
    expect(kept?.lastCoveredPeriodEnd?.toISOString()).toBe(moved.toISOString());
    expect(kept?.consecutiveFailureCount).toBe(3);
  });

  it('CONCURRENT PASSES DO NOT DUPLICATE — ON CONFLICT DO NOTHING is the arbiter', async () => {
    const workspaceId = fixtures.a.workspaceId;
    await withWorkspace(
      workspaceId,
      async (db) => db.analyticsIngestionCursor.deleteMany({ where: { workspaceId } }),
      { prisma: app },
    );

    const passes = await Promise.all(
      [1, 2, 3].map(() =>
        withWorkspace(
          workspaceId,
          async (db) => ensureIngestionCursors({ db, workspaceId, registry }),
          { prisma: app },
        ),
      ),
    );

    const totalClaimed = (passes as { created: number }[]).reduce((n, p) => n + p.created, 0);
    const actual = await cursorCount(workspaceId);
    // Every row that exists was created exactly once, whichever pass won it.
    expect(totalClaimed).toBe(actual);
  });

  it('DOES NOT REACH ANOTHER WORKSPACE — the pass is tenant-scoped', async () => {
    const before = await cursorCount(fixtures.b.workspaceId);
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => ensureIngestionCursors({ db, workspaceId: fixtures.a.workspaceId, registry }),
      { prisma: app },
    );
    expect(await cursorCount(fixtures.b.workspaceId)).toBe(before);
  });
});
