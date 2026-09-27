import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  AnalyticsQueryService,
  createAnalyticsRegistry,
  highestPooledRates,
  parseAnalyticsPolicy,
} from '@brandspace/analytics';
import {
  CAMPAIGN_ALREADY_ENDED_REASON,
  CAMPAIGN_NOT_PLANNED_REASON,
  CampaignService,
} from '@brandspace/content';
import { defaultPayload } from '@brandspace/config';
import { fixedClock } from '@brandspace/shared';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * B11 (Phase 2B-2b) — CAMPAIGN RESULTS, AGAINST REAL POSTGRESQL.
 *
 *   1. `update()` is a CONDITIONAL write: two saves against one version, run in
 *      parallel, leave exactly one winner and one CONFLICT.
 *   2. "Start now" is `update()` with two fields fixed — PLANNED only, never past
 *      the end date, today in the WORKSPACE's zone, one audited transaction.
 *   3. The Best campaign rate is POOLED over each campaign's posts, a post whose
 *      rate is unavailable is left out of BOTH sides, archived campaigns are
 *      excluded, and neither another brand nor another workspace ever counts.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let brandId: string;
let otherBrandId: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

/** 12:00 UTC on 10 October 2026 — 15:00 in Riyadh, the same calendar day. */
const NOW = new Date('2026-10-10T12:00:00.000Z');
const campaigns = (db: TenantScopedClient, workspaceId = fixtures.a.workspaceId) =>
  new CampaignService({ db, workspaceId, clock: fixedClock(NOW) });
const actor = () => ({ userId: fixtures.a.userId, brandScope: [] as string[] });

function queries(db: TenantScopedClient, workspaceId: string): AnalyticsQueryService {
  return new AnalyticsQueryService({
    db,
    workspaceId,
    policy: parseAnalyticsPolicy(defaultPayload('analytics')),
    registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
    clock: fixedClock(NOW),
  });
}

async function newBrand(workspaceId: string, name: string): Promise<string> {
  const run = workspaceId === fixtures.a.workspaceId ? inA : inB;
  return (
    await run((db) =>
      db.brand.create({
        data: {
          workspaceId,
          slug: `${name}-${randomUUID().slice(0, 8)}`,
          name,
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
    )
  ).id;
}

async function campaign(input: {
  brand: string;
  status?: 'DRAFT' | 'PLANNED' | 'ACTIVE';
  startDate?: string;
  endDate?: string;
  archived?: boolean;
}): Promise<string> {
  const row = await platform.campaign.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: input.brand,
      name: `Campaign ${randomUUID().slice(0, 6)}`,
      objective: 'ENGAGEMENT',
      status: input.archived ? 'ARCHIVED' : (input.status ?? 'ACTIVE'),
      ...(input.startDate ? { startDate: new Date(`${input.startDate}T00:00:00.000Z`) } : {}),
      ...(input.endDate ? { endDate: new Date(`${input.endDate}T00:00:00.000Z`) } : {}),
      ...(input.archived ? { deletedAt: NOW } : {}),
    },
    select: { id: true },
  });
  return row.id;
}

/** A published post in a campaign, with the given lifetime readings. */
async function post(
  campaignId: string,
  brand: string,
  readings: { engagements?: number[]; impressions?: number[] },
): Promise<string> {
  const item = await platform.contentItem.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: brand,
      campaignId,
      title: 'Post',
      contentType: 'POST',
      primaryLocale: 'EN',
      status: 'PUBLISHED',
      createdByUserId: fixtures.a.userId,
    } as never,
    select: { id: true },
  });
  const subject = `ext-${randomUUID()}`;
  for (const [metricKey, values] of Object.entries(readings)) {
    for (const [day, value] of (values ?? []).entries()) {
      const periodStart = new Date(Date.UTC(2026, 8, 1 + day));
      const periodEnd = new Date(periodStart.getTime() + 86_400_000);
      await platform.metricObservation.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: brand,
          socialConnectionId: fixtures.a.socialConnectionId,
          provider: 'LINKEDIN',
          subjectType: 'POST',
          subjectExternalId: subject,
          contentItemId: item.id,
          metricKey,
          granularity: 'DAY',
          periodStart,
          periodEnd,
          value: BigInt(value),
          unit: 'COUNT',
          observedAt: periodEnd,
          sourceKind: 'PROVIDER',
          sourceVersion: 'test',
          observationKey: createHash('sha256')
            .update(`${subject}|${metricKey}|${periodStart.toISOString()}`)
            .digest('hex'),
        },
      });
    }
  }
  return item.id;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  await platform.workspace.update({
    where: { id: fixtures.a.workspaceId },
    data: { timezone: 'Asia/Riyadh' },
  });
  brandId = await newBrand(fixtures.a.workspaceId, 'results');
  otherBrandId = await newBrand(fixtures.a.workspaceId, 'results-other');
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('update() is a conditional write', () => {
  it('two saves against the same version: exactly one wins, the other is a CONFLICT', async () => {
    const id = await campaign({ brand: brandId, status: 'DRAFT' });
    const { version } = await platform.campaign.findUniqueOrThrow({ where: { id } });
    const results = await Promise.allSettled(
      ['First', 'Second'].map((name) =>
        inA((db) =>
          campaigns(db).update({ campaignId: id, expectedVersion: version, name, actor: actor() }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'CONFLICT' });
    const row = await platform.campaign.findUniqueOrThrow({ where: { id } });
    expect(row.version).toBe(version + 1);
  });

  it('a save against a stale version writes nothing', async () => {
    const id = await campaign({ brand: brandId, status: 'DRAFT' });
    const before = await platform.campaign.findUniqueOrThrow({ where: { id } });
    await expect(
      inA((db) =>
        campaigns(db).update({
          campaignId: id,
          expectedVersion: before.version + 5,
          name: 'Late',
          actor: actor(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const after = await platform.campaign.findUniqueOrThrow({ where: { id } });
    expect(after.name).toBe(before.name);
    expect(after.version).toBe(before.version);
  });
});

describe('"Start now"', () => {
  it('moves a PLANNED campaign to ACTIVE, starting today in the workspace zone, audited', async () => {
    const id = await campaign({
      brand: brandId,
      status: 'PLANNED',
      startDate: '2026-11-01',
      endDate: '2026-11-30',
    });
    const started = await inA((db) =>
      campaigns(db).startNow({ campaignId: id, timezone: 'Asia/Riyadh', actor: actor() }),
    );
    expect(started.status).toBe('ACTIVE');
    expect(started.startDate?.toISOString().slice(0, 10)).toBe('2026-10-10');
    expect(started.endDate?.toISOString().slice(0, 10)).toBe('2026-11-30');
    const audit = await platform.auditEvent.findFirstOrThrow({
      where: { resourceId: id, action: 'campaign.updated' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.reason).toBe('start_now');
    expect(audit.after).toMatchObject({ status: 'ACTIVE' });
  });

  it('"today" is the workspace’s day, not UTC’s', async () => {
    // 22:30 UTC on 10 October is already 11 October in Riyadh.
    const lateNow = new Date('2026-10-10T22:30:00.000Z');
    const id = await campaign({ brand: brandId, status: 'PLANNED', startDate: '2026-12-01' });
    const started = await inA((db) =>
      new CampaignService({
        db,
        workspaceId: fixtures.a.workspaceId,
        clock: fixedClock(lateNow),
      }).startNow({ campaignId: id, timezone: 'Asia/Riyadh', actor: actor() }),
    );
    expect(started.startDate?.toISOString().slice(0, 10)).toBe('2026-10-11');
  });

  it('refuses a campaign that is not PLANNED, and changes nothing', async () => {
    const id = await campaign({ brand: brandId, status: 'DRAFT' });
    await expect(
      inA((db) =>
        campaigns(db).startNow({ campaignId: id, timezone: 'Asia/Riyadh', actor: actor() }),
      ),
    ).rejects.toMatchObject({ publicDetails: { reason: CAMPAIGN_NOT_PLANNED_REASON } });
    expect((await platform.campaign.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT');
  });

  it('refuses a campaign whose end date has passed, and never moves the end date', async () => {
    const id = await campaign({
      brand: brandId,
      status: 'PLANNED',
      startDate: '2026-09-01',
      endDate: '2026-10-09',
    });
    await expect(
      inA((db) =>
        campaigns(db).startNow({ campaignId: id, timezone: 'Asia/Riyadh', actor: actor() }),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      publicDetails: { reason: CAMPAIGN_ALREADY_ENDED_REASON },
    });
    const row = await platform.campaign.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PLANNED');
    expect(row.endDate?.toISOString().slice(0, 10)).toBe('2026-10-09');
  });

  it('a campaign ending TODAY can still start today', async () => {
    const id = await campaign({ brand: brandId, status: 'PLANNED', endDate: '2026-10-10' });
    const started = await inA((db) =>
      campaigns(db).startNow({ campaignId: id, timezone: 'Asia/Riyadh', actor: actor() }),
    );
    expect(started.status).toBe('ACTIVE');
  });

  it('refuses a stale version rather than acting on an old read', async () => {
    const id = await campaign({ brand: brandId, status: 'PLANNED' });
    const { version } = await platform.campaign.findUniqueOrThrow({ where: { id } });
    await expect(
      inA((db) =>
        campaigns(db).startNow({
          campaignId: id,
          timezone: 'Asia/Riyadh',
          expectedVersion: version - 1,
          actor: actor(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('another workspace sees NOT_FOUND, shaped like a genuine miss', async () => {
    const id = await campaign({ brand: brandId, status: 'PLANNED' });
    await expect(
      inB((db) =>
        campaigns(db, fixtures.b.workspaceId).startNow({
          campaignId: id,
          timezone: 'UTC',
          actor: { userId: fixtures.b.userId, brandScope: [] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await platform.campaign.findUniqueOrThrow({ where: { id } })).status).toBe('PLANNED');
  });

  it('a member restricted to another brand sees NOT_FOUND', async () => {
    const id = await campaign({ brand: brandId, status: 'PLANNED' });
    await expect(
      inA((db) =>
        campaigns(db).startNow({
          campaignId: id,
          timezone: 'Asia/Riyadh',
          actor: { userId: fixtures.a.userId, brandScope: [otherBrandId] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('Best campaign: pooled lifetime engagement rate (D-341)', () => {
  let high: string;
  let low: string;
  let archived: string;
  let otherBrandCampaign: string;

  beforeAll(async () => {
    high = await campaign({ brand: brandId });
    low = await campaign({ brand: brandId });
    archived = await campaign({ brand: brandId, archived: true });
    otherBrandCampaign = await campaign({ brand: otherBrandId });

    // high: 30 + 10 engagements over 200 + 200 impressions = 10.0% pooled.
    // A post with engagements and NO impressions reading is left out of both
    // sides — its 900 engagements must not lift the rate.
    await post(high, brandId, { engagements: [20, 10], impressions: [100, 100] });
    await post(high, brandId, { engagements: [10], impressions: [200] });
    await post(high, brandId, { engagements: [900] });
    // low: 5 / 1000 = 0.5%, and a post with impressions but no engagements
    // reading must not dilute it either.
    await post(low, brandId, { engagements: [5], impressions: [1000] });
    await post(low, brandId, { impressions: [50_000] });
    // An archived campaign with a spectacular rate never competes.
    await post(archived, brandId, { engagements: [99], impressions: [100] });
    await post(otherBrandCampaign, otherBrandId, { engagements: [50], impressions: [100] });
  }, 60_000);

  it('pools each campaign, leaving out posts whose rate is unavailable', async () => {
    const rates = await inA((db) =>
      queries(db, fixtures.a.workspaceId).campaignEngagementRates({ brandId, brandScope: [] }),
    );
    expect(rates.get(high)).toMatchObject({
      engagements: 40n,
      impressions: 400n,
      posts: 2,
      rateMilli: 100n,
    });
    expect(rates.get(low)).toMatchObject({ engagements: 5n, impressions: 1000n, posts: 1 });
    expect(rates.has(archived)).toBe(false);
    expect(rates.has(otherBrandCampaign)).toBe(false);
    expect(highestPooledRates(rates).map((rate) => rate.campaignId)).toEqual([high]);
  });

  it('"all brands" means the brands this member may access, and no further', async () => {
    const everything = await inA((db) =>
      queries(db, fixtures.a.workspaceId).campaignEngagementRates({ brandScope: [] }),
    );
    expect(everything.has(otherBrandCampaign)).toBe(true);
    const restricted = await inA((db) =>
      queries(db, fixtures.a.workspaceId).campaignEngagementRates({ brandScope: [brandId] }),
    );
    expect(restricted.has(otherBrandCampaign)).toBe(false);
    expect(restricted.has(high)).toBe(true);
  });

  it('a named brand outside the member’s scope is refused like a missing one', async () => {
    await expect(
      inA((db) =>
        queries(db, fixtures.a.workspaceId).campaignEngagementRates({
          brandId: otherBrandId,
          brandScope: [brandId],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('another workspace sees none of it', async () => {
    const fromB = await inB((db) =>
      queries(db, fixtures.b.workspaceId).campaignEngagementRates({ brandScope: [] }),
    );
    for (const id of [high, low, archived, otherBrandCampaign]) expect(fromB.has(id)).toBe(false);
  });
});
