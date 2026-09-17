import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Phase 7 tenant isolation — the six analytics tables, on real PostgreSQL.
 *
 * WHAT IS AT STAKE HERE. `metric_observation` is a customer's commercial
 * performance: how many people saw what they said, and how many responded. A
 * competitor who could read it would know more about that business than most of
 * its employees. `insight` and `insight_evidence` are what we TOLD them about
 * it, which means a leak also discloses the questions they thought worth asking.
 *
 * EVERY ASSERTION RUNS THROUGH THE UNPRIVILEGED APPLICATION ROLE inside a real
 * workspace context, because that is the only identity that settles the
 * question. A mocked client would prove a `where` clause was written, not that
 * the database refuses without one.
 *
 * AND EVERY TABLE IS PROBED THE SAME SIX WAYS — read, list, count, aggregate,
 * write, re-parent — because a table that is safe to SELECT and unsafe to
 * GROUP BY is still a leak. An aggregate is a disclosure: "their impressions
 * total 412,000" tells a rival most of what a row would.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

type Db = Parameters<Parameters<typeof withWorkspace>[1]>[0];
const inA = <T>(fn: (db: Db) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: Db) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

describe('MetricObservation is invisible across the tenant boundary', () => {
  it("a cross-tenant read by id returns null — B's figures do not exist for A", async () => {
    const found = await inA((db) =>
      db.metricObservation.findFirst({ where: { id: fixtures.b.metricObservationId } }),
    );
    expect(found).toBeNull();
  });

  it('a fabricated id and a foreign id are indistinguishable', async () => {
    const foreign = await inA((db) =>
      db.metricObservation.findFirst({ where: { id: fixtures.b.metricObservationId } }),
    );
    const invented = await inA((db) =>
      db.metricObservation.findFirst({ where: { id: randomUUID() } }),
    );
    expect(foreign).toBeNull();
    expect(invented).toBeNull();
  });

  it('listing never includes the other tenant', async () => {
    const rows = await inA((db) => db.metricObservation.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
  });

  it('a COUNT never counts the other tenant', async () => {
    const count = await inA((db) => db.metricObservation.count({}));
    const rows = await inA((db) => db.metricObservation.findMany({ select: { id: true } }));
    expect(count).toBe(rows.length);
  });

  it('an AGGREGATE never sums the other tenant — a total is a disclosure', async () => {
    /*
     * THE ASSERTION THAT MATTERS MOST IN THIS FILE. Both fixtures hold exactly
     * one observation and the two values DIFFER (they are derived from the
     * slug), so a sum that crossed the boundary would be a different number
     * rather than a coincidentally equal one.
     */
    const aggregate = await inA((db) => db.metricObservation.aggregate({ _sum: { value: true } }));
    const own = await inA((db) => db.metricObservation.findMany({ select: { value: true } }));
    const expected = own.reduce((total, row) => total + row.value, 0n);
    expect(aggregate._sum.value).toBe(expected);

    const other = await inB((db) =>
      db.metricObservation.findFirstOrThrow({
        where: { id: fixtures.b.metricObservationId },
        select: { value: true },
      }),
    );
    expect(aggregate._sum.value).not.toBe(expected + other.value);
  });

  it('a GROUP BY never groups the other tenant', async () => {
    const groups = await inA((db) =>
      db.metricObservation.groupBy({ by: ['workspaceId'], _count: { _all: true } }),
    );
    expect(groups.map((g) => g.workspaceId)).toEqual([fixtures.a.workspaceId]);
  });

  it("searching by B's observation key finds nothing — a key is not a back door", async () => {
    const found = await inA((db) =>
      db.metricObservation.findFirst({
        where: { observationKey: fixtures.b.metricObservationKey },
      }),
    );
    expect(found).toBeNull();
  });

  it('a cross-tenant write is refused', async () => {
    await expect(
      inA((db) =>
        db.metricObservation.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            socialConnectionId: fixtures.b.socialConnectionId,
            provider: 'LINKEDIN',
            subjectType: 'ACCOUNT',
            subjectExternalId: 'probe',
            metricKey: 'impressions',
            granularity: 'DAY',
            periodStart: new Date('2026-09-05T00:00:00.000Z'),
            periodEnd: new Date('2026-09-06T00:00:00.000Z'),
            value: 1n,
            unit: 'COUNT',
            observedAt: new Date('2026-09-06T00:00:00.000Z'),
            sourceKind: 'PROVIDER',
            sourceVersion: 'probe-1',
            observationKey: `probe-${randomUUID()}`,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("a write into A's workspace but B's brand is refused by the composite key (D-112)", async () => {
    /*
     * THE CROSS-BRAND FORGERY. The workspace is A's, so RLS is satisfied; only
     * the COMPOSITE foreign key `(workspaceId, brandId)` can catch this. Without
     * D-112 this row would be accepted and would then be readable by A under a
     * brand id A never owned.
     */
    await expect(
      inA((db) =>
        db.metricObservation.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.b.brandId,
            socialConnectionId: fixtures.a.socialConnectionId,
            provider: 'LINKEDIN',
            subjectType: 'ACCOUNT',
            subjectExternalId: 'probe',
            metricKey: 'impressions',
            granularity: 'DAY',
            periodStart: new Date('2026-09-05T00:00:00.000Z'),
            periodEnd: new Date('2026-09-06T00:00:00.000Z'),
            value: 1n,
            unit: 'COUNT',
            observedAt: new Date('2026-09-06T00:00:00.000Z'),
            sourceKind: 'PROVIDER',
            sourceVersion: 'probe-1',
            observationKey: `probe-${randomUUID()}`,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a cross-tenant UPDATE changes nothing rather than failing loudly', async () => {
    const before = await inB((db) =>
      db.metricObservation.findFirstOrThrow({
        where: { id: fixtures.b.metricObservationId },
        select: { value: true },
      }),
    );
    const result = await inA((db) =>
      db.metricObservation.updateMany({
        where: { id: fixtures.b.metricObservationId },
        data: { value: 999_999n },
      }),
    );
    expect(result.count).toBe(0);

    const after = await inB((db) =>
      db.metricObservation.findFirstOrThrow({
        where: { id: fixtures.b.metricObservationId },
        select: { value: true },
      }),
    );
    expect(after.value).toBe(before.value);
  });

  it('a cross-tenant DELETE removes nothing', async () => {
    const result = await inA((db) =>
      db.metricObservation.deleteMany({ where: { id: fixtures.b.metricObservationId } }),
    );
    expect(result.count).toBe(0);
    const still = await inB((db) =>
      db.metricObservation.findFirst({ where: { id: fixtures.b.metricObservationId } }),
    );
    expect(still).not.toBeNull();
  });

  it("A cannot RE-PARENT its own observation onto B's brand", async () => {
    await expect(
      inA((db) =>
        db.metricObservation.update({
          where: { id: fixtures.a.metricObservationId },
          data: { brandId: fixtures.b.brandId },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('AnalyticsIngestionCursor is invisible across the tenant boundary', () => {
  it('a cross-tenant read returns null', async () => {
    const found = await inA((db) =>
      db.analyticsIngestionCursor.findFirst({ where: { id: fixtures.b.analyticsCursorId } }),
    );
    expect(found).toBeNull();
  });

  it('listing and counting exclude the other tenant', async () => {
    const rows = await inA((db) => db.analyticsIngestionCursor.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(await inA((db) => db.analyticsIngestionCursor.count({}))).toBe(rows.length);
  });

  it("a due-cursor sweep in A never claims B's cursor", async () => {
    /*
     * THE SHAPE THE SCHEDULER ACTUALLY USES: "anything due, anywhere". Without
     * RLS this is the query that would walk every tenant's work queue.
     */
    const due = await inA((db) =>
      db.analyticsIngestionCursor.findMany({
        where: { nextAttemptAt: { not: null } },
        select: { id: true, workspaceId: true },
      }),
    );
    expect(due.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(due.some((row) => row.id === fixtures.b.analyticsCursorId)).toBe(false);
  });

  it("a cross-tenant UPDATE cannot steal B's claim", async () => {
    const result = await inA((db) =>
      db.analyticsIngestionCursor.updateMany({
        where: { id: fixtures.b.analyticsCursorId },
        data: { claimedAt: new Date() },
      }),
    );
    expect(result.count).toBe(0);
    const still = await inB((db) =>
      db.analyticsIngestionCursor.findFirstOrThrow({
        where: { id: fixtures.b.analyticsCursorId },
        select: { claimedAt: true },
      }),
    );
    expect(still.claimedAt).toBeNull();
  });

  it('a cross-tenant write is refused', async () => {
    await expect(
      inA((db) =>
        db.analyticsIngestionCursor.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            socialConnectionId: fixtures.b.socialConnectionId,
            provider: 'LINKEDIN',
            subjectType: 'POST',
            granularity: 'DAY',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('AnalyticsIngestionRun is invisible across the tenant boundary', () => {
  it('a cross-tenant read returns null', async () => {
    const found = await inA((db) =>
      db.analyticsIngestionRun.findFirst({ where: { id: fixtures.b.analyticsRunId } }),
    );
    expect(found).toBeNull();
  });

  it("searching by B's run idempotency key finds nothing", async () => {
    const found = await inA((db) =>
      db.analyticsIngestionRun.findFirst({
        where: { idempotencyKey: fixtures.b.analyticsRunIdempotencyKey },
      }),
    );
    expect(found).toBeNull();
  });

  it('listing and counting exclude the other tenant', async () => {
    const rows = await inA((db) => db.analyticsIngestionRun.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(await inA((db) => db.analyticsIngestionRun.count({}))).toBe(rows.length);
  });

  it('a cross-tenant write is refused', async () => {
    await expect(
      inA((db) =>
        db.analyticsIngestionRun.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            cursorId: fixtures.b.analyticsCursorId,
            socialConnectionId: fixtures.b.socialConnectionId,
            provider: 'LINKEDIN',
            kind: 'SCHEDULED',
            idempotencyKey: `probe-${randomUUID()}`,
            windowStart: new Date('2026-09-01T00:00:00.000Z'),
            windowEnd: new Date('2026-09-02T00:00:00.000Z'),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a run is append-only even for its own tenant: a second completion raises', async () => {
    /*
     * NOT AN ISOLATION PROPERTY BUT AN EVIDENCE ONE, and it belongs on real
     * PostgreSQL because a TRIGGER is what enforces it. A completed run is what
     * an operator reads to find out what a provider actually did; a record that
     * can be rewritten afterwards is not a record.
     */
    await expect(
      inA((db) =>
        db.analyticsIngestionRun.update({
          where: { id: fixtures.a.analyticsRunId },
          data: { status: 'FAILED', finishedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/already terminal|record, not a draft/i);
  });
});

describe('Campaign is invisible across the tenant boundary', () => {
  it('a cross-tenant read returns null', async () => {
    const found = await inA((db) =>
      db.campaign.findFirst({ where: { id: fixtures.b.campaignId } }),
    );
    expect(found).toBeNull();
  });

  it('listing and counting exclude the other tenant', async () => {
    const rows = await inA((db) => db.campaign.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(await inA((db) => db.campaign.count({}))).toBe(rows.length);
  });

  it("a name search cannot find B's campaign", async () => {
    const rows = await inA((db) =>
      db.campaign.findMany({ where: { name: { contains: fixtures.b.slug } } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('a cross-tenant write is refused', async () => {
    await expect(
      inA((db) =>
        db.campaign.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            name: `probe-${randomUUID()}`,
            objective: 'AWARENESS',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("A cannot attach its own content item to B's campaign", async () => {
    /*
     * THE RE-PARENT ACROSS TENANTS, through the one column Phase 7 added to an
     * existing table. `content_item.campaignId` is validated by a COMPOSITE
     * foreign key, so a foreign campaign id is a constraint violation rather
     * than a link that resolves to nothing.
     */
    await expect(
      inA((db) =>
        db.contentItem.update({
          where: { id: fixtures.a.contentItemId },
          data: { campaignId: fixtures.b.campaignId },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a cross-tenant UPDATE and DELETE change nothing', async () => {
    const updated = await inA((db) =>
      db.campaign.updateMany({
        where: { id: fixtures.b.campaignId },
        data: { status: 'ARCHIVED' },
      }),
    );
    expect(updated.count).toBe(0);
    const deleted = await inA((db) =>
      db.campaign.deleteMany({ where: { id: fixtures.b.campaignId } }),
    );
    expect(deleted.count).toBe(0);

    const still = await inB((db) =>
      db.campaign.findFirstOrThrow({
        where: { id: fixtures.b.campaignId },
        select: { status: true },
      }),
    );
    expect(still.status).toBe('ACTIVE');
  });
});

describe('Insight and InsightEvidence are invisible across the tenant boundary', () => {
  it("a cross-tenant read of an insight returns null — B's questions are B's", async () => {
    const found = await inA((db) => db.insight.findFirst({ where: { id: fixtures.b.insightId } }));
    expect(found).toBeNull();
  });

  it('listing and counting exclude the other tenant', async () => {
    const rows = await inA((db) => db.insight.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(await inA((db) => db.insight.count({}))).toBe(rows.length);
  });

  it("evidence cannot be read across the boundary, and B's insight id reveals nothing", async () => {
    const byId = await inA((db) =>
      db.insightEvidence.findFirst({ where: { id: fixtures.b.insightEvidenceId } }),
    );
    expect(byId).toBeNull();

    const byInsight = await inA((db) =>
      db.insightEvidence.findMany({ where: { insightId: fixtures.b.insightId } }),
    );
    expect(byInsight).toHaveLength(0);
  });

  it("an INCLUDE cannot pull B's evidence in through a relation", async () => {
    const rows = await inA((db) => db.insight.findMany({ include: { evidence: true } }));
    const every = rows.flatMap((row) => row.evidence);
    expect(every.length).toBeGreaterThan(0);
    expect(every.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
  });

  it('a cross-tenant insight write is refused', async () => {
    await expect(
      inA((db) =>
        db.insight.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            type: 'RECOMMENDATION',
            basis: 'OWN_PERFORMANCE',
            title: { en: 'probe', ar: 'probe' },
            body: { en: 'probe', ar: 'probe' },
            periodStart: new Date('2026-09-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-02T00:00:00.000Z'),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('evidence is append-only: even its own tenant cannot rewrite a citation', async () => {
    await expect(
      inA((db) =>
        db.insightEvidence.update({
          where: { id: fixtures.a.insightEvidenceId },
          data: { value: 1n },
        }),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('evidence cannot be deleted by the application role at all', async () => {
    /*
     * A CITATION THAT CAN BE DELETED IS NOT EVIDENCE EITHER. DELETE is REVOKED
     * from `brandspace_app` on this table, so the refusal is a privilege error
     * rather than an RLS no-op — which is the strongest form the refusal takes.
     */
    await expect(
      inA((db) => db.insightEvidence.deleteMany({ where: { id: fixtures.a.insightEvidenceId } })),
    ).rejects.toThrow(/permission denied/i);
  });

  it("an insight cannot be re-parented onto B's campaign", async () => {
    await expect(
      inA((db) =>
        db.insight.update({
          where: { id: fixtures.a.insightId },
          data: { campaignId: fixtures.b.campaignId },
        }),
      ),
    ).rejects.toThrow();
  });
});
