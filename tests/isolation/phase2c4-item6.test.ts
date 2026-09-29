import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSessionToken, type CustomerWorkspaceContext } from '@brandspace/auth';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import {
  BrandKnowledgeService,
  brandBrainChangedSince,
  knowledgeSignatureFor,
  knowledgeSignatureOf,
  usableFactsForDisplay,
} from '@brandspace/brand-brain';
import {
  AnalyticsQueryService,
  createAnalyticsRegistry,
  parseAnalyticsPolicy,
} from '@brandspace/analytics';
import { StrategyService, acknowledgeKnowledgeChange } from '@brandspace/intelligence';
import { attentionItems } from '../../apps/dashboard/src/server/command-center';
import { buildServer } from '../../apps/api/src/server';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2C-4 (Item 6) — D11, D12, D13 and the Strategy display lists, against
 * real PostgreSQL under the application role (RLS on), and D11's two routes
 * through the real HTTP handler:
 *
 *   - D11: the per-card route is `brand_brain.edit`; the batch route keeps
 *     `brand_brain.review`; both run `proposeFromInsight` — PENDING LEARNINGS
 *     candidates from ANALYTICS with the insight, never approved, and a repeat
 *     creates nothing; another workspace's insight is a miss;
 *   - D12: one review row counting every PENDING source kind, no
 *     `learnings-pending`, the missing-question row, each behind its
 *     permission and brand scope;
 *   - D13: the signature moves with a usable version, an archive, an expiry or
 *     a new approval — and not with a pending candidate, an unusable fact or a
 *     read; the Strategy engine stores it; a NULL baseline never alerts;
 *   - the display lists: usable ACTIVE and STALE shown, expired and archived
 *     hidden.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let server: Awaited<ReturnType<typeof buildServer>>;

const STALENESS = { reviewIntervalDays: 90 };
const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const knowledge = (db: TenantScopedClient) =>
  new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId });
const actor = (permissionKeys: readonly string[] = ['brand_brain.edit', 'brand_brain.review']) => ({
  userId: fixtures.a.userId,
  permissionKeys,
  brandScope: [] as readonly string[],
});

/* ------------------------------------------------------------ members + HTTP */

const tokens = { edit: '', review: '', none: '', manage: '', readOnly: '' };

async function memberWithKeys(keys: readonly string[], label: string): Promise<string> {
  const run = randomUUID().slice(0, 8);
  const role = await platform.role.create({
    data: {
      workspaceId: null,
      key: `p2c4-${label}-${run}`,
      realm: 'WORKSPACE',
      nameEn: `2C-4 ${label}`,
      nameAr: `2C-4 ${label}`,
    },
  });
  const permissions = await platform.permission.findMany({ where: { key: { in: [...keys] } } });
  expect(permissions.length).toBe(keys.length);
  await platform.rolePermission.createMany({
    data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
  });
  const user = await platform.user.create({
    data: {
      email: `p2c4-${label}-${run}@example.local`,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      timezone: 'UTC',
    },
  });
  await platform.membership.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE',
      acceptedAt: new Date(),
      brandScope: [],
    },
  });
  const token = `p2c4-${label}-${randomUUID()}`;
  await platform.customerSession.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(token),
      activeWorkspaceId: fixtures.a.workspaceId,
      expiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000),
    },
  });
  return token;
}

async function post(url: string, token: string, payload: unknown) {
  const response = await server.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: payload as never,
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

/* ------------------------------------------------------ measured performance */

const WINDOW_START = new Date('2026-07-01T00:00:00.000Z');
const DAYS = 25;
/**
 * Twenty-one steady days, then four sharp ones: past the configured baseline
 * (`analytics.anomaly.baselinePeriods`, fourteen by default), the later days sit
 * far above it more than once — a SUSTAINED anomaly, which is what a learning
 * may be drawn from.
 */
const steadyThenJump = (base: number, jump: number) =>
  Array.from({ length: DAYS }, (_x, day) => (day < 21 ? base + (day % 3) * 10 : jump));
const SERIES: Record<string, readonly number[]> = {
  impressions: steadyThenJump(1_200, 4_800),
  engagements: steadyThenJump(60, 260),
  reach: steadyThenJump(1_000, 4_000),
};

/** Seeds the series above for the fixture's connected account, and an insight over its window. */
async function seedPerformance(): Promise<string> {
  const connection = await platform.socialConnection.findUniqueOrThrow({
    where: { id: fixtures.a.socialConnectionId },
  });
  await inA(async (db) => {
    for (const [metricKey, values] of Object.entries(SERIES)) {
      for (let day = 0; day < DAYS; day += 1) {
        const periodStart = new Date(WINDOW_START.getTime() + day * 86_400_000);
        const periodEnd = new Date(periodStart.getTime() + 86_400_000);
        await db.metricObservation.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: connection.brandId,
            socialConnectionId: connection.id,
            provider: connection.provider,
            subjectType: 'ACCOUNT',
            subjectExternalId: connection.externalAccountId,
            metricKey,
            granularity: 'DAY',
            periodStart,
            periodEnd,
            value: BigInt(values[day] ?? 0),
            unit: 'COUNT',
            observedAt: periodEnd,
            sourceKind: 'MOCK',
            sourceVersion: 'p2c4-item6',
            observationKey: createHash('sha256')
              .update(`p2c4|${connection.id}|${metricKey}|${periodStart.toISOString()}`)
              .digest('hex'),
          },
        });
      }
    }
  });
  const insight = await inA((db) =>
    db.insight.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: connection.brandId,
        type: 'ANOMALY',
        status: 'NEW',
        basis: 'OWN_PERFORMANCE',
        title: { en: 'Impressions jumped', ar: 'قفزت مرات الظهور' },
        body: {},
        periodStart: WINDOW_START,
        periodEnd: new Date(WINDOW_START.getTime() + DAYS * 86_400_000),
        generatedByUserId: fixtures.a.userId,
      },
    }),
  );
  return insight.id;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  tokens.edit = await memberWithKeys(
    ['workspace.read', 'brand_brain.read', 'brand_brain.edit'],
    'edit',
  );
  tokens.review = await memberWithKeys(
    ['workspace.read', 'brand_brain.read', 'brand_brain.review'],
    'review',
  );
  tokens.none = await memberWithKeys(['workspace.read', 'brand_brain.read'], 'none');
  tokens.manage = await memberWithKeys(
    ['workspace.read', 'strategy.read', 'strategy.manage'],
    'manage',
  );
  tokens.readOnly = await memberWithKeys(['workspace.read', 'strategy.read'], 'read');
  server = await buildServer();
  await server.ready();
}, 90_000);

afterAll(async () => {
  await server?.close();
  await app?.$disconnect();
  await platform?.$disconnect();
});

/* ======================================================================== */

describe('D11 — Save as learning', () => {
  let insightId = '';
  beforeAll(async () => {
    insightId = await seedPerformance();
  });

  const learnings = () =>
    platform.brandKnowledgeCandidate.findMany({
      where: { workspaceId: fixtures.a.workspaceId, insightId },
    });

  it('the per-card route needs brand_brain.edit; the batch route keeps brand_brain.review', async () => {
    expect((await post('/v1/insights/save-learning', tokens.none, { insightId })).status).toBe(404);
    expect((await post('/v1/insights/save-learning', tokens.review, { insightId })).status).toBe(
      404,
    );
    expect((await post('/v1/insights/learnings', tokens.edit, { insightId })).status).toBe(404);
    expect(await learnings()).toHaveLength(0);
  });

  it('saves PENDING LEARNINGS candidates from ANALYTICS with the insight, never approved', async () => {
    const saved = await post('/v1/insights/save-learning', tokens.edit, { insightId });
    expect(saved.status).toBe(200);
    expect(Number(saved.body['created'])).toBeGreaterThan(0);
    const rows = await learnings();
    expect(rows.length).toBe(Number(saved.body['created']));
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'PENDING',
        area: 'LEARNINGS',
        sourceKind: 'ANALYTICS',
        insightId,
        sourceDocumentId: null,
        reviewedByUserId: null,
      });
    }
    // Nothing reached approved knowledge.
    expect(
      await platform.brandKnowledgeItem.count({
        where: { workspaceId: fixtures.a.workspaceId, itemKey: { in: rows.map((r) => r.itemKey) } },
      }),
    ).toBe(0);
  });

  it('saving the same insight again creates nothing — through either route', async () => {
    const before = (await learnings()).map((row) => row.id).sort();
    const again = await post('/v1/insights/save-learning', tokens.edit, { insightId });
    expect(again.status).toBe(200);
    expect(again.body['created']).toBe(0);
    const batch = await post('/v1/insights/learnings', tokens.review, { insightId });
    expect(batch.status).toBe(200);
    expect(batch.body['created']).toBe(0);
    expect((await learnings()).map((row) => row.id).sort()).toEqual(before);
  });

  it('another workspace’s insight is a miss, and nothing is written there', async () => {
    const response = await post('/v1/insights/save-learning', tokens.edit, {
      insightId: fixtures.b.insightId,
    });
    expect(response.status).toBe(404);
    expect(
      await platform.brandKnowledgeCandidate.count({
        where: { workspaceId: fixtures.b.workspaceId, insightId: fixtures.b.insightId },
      }),
    ).toBe(0);
  });
});

/* ======================================================================== */

function session(
  permissionKeys: readonly string[],
  brandScope: readonly string[] = [],
): CustomerWorkspaceContext {
  return {
    workspaceId: fixtures.a.workspaceId,
    workspaceName: 'A',
    workspaceSlug: 'a',
    workspaceStatus: 'ACTIVE',
    roleKey: 'workspace_owner',
    roleNameEn: 'Owner',
    roleNameAr: 'مالك',
    permissionKeys,
    brandScope,
  };
}

describe('D12 — Home: facts waiting for review, and what Brand Brain is missing', () => {
  it('one review row counts every PENDING source kind; no learnings-pending row', async () => {
    // A MEMBER proposal and an ANALYTICS learning beside the fixture's DOCUMENT candidate.
    await inA((db) =>
      db.brandKnowledgeCandidate.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sourceKind: 'MEMBER',
          proposedByUserId: fixtures.a.userId,
          area: 'OFFERS',
          itemKey: `offers.p2c4-${randomUUID().slice(0, 6)}`,
          extractedTitle: { en: 'A member proposal' },
          extractedBody: { en: 'Proposed by a member.' },
          confidenceMilli: 1000,
          evidence: [],
        },
      }),
    );
    const pending = await platform.brandKnowledgeCandidate.groupBy({
      by: ['sourceKind'],
      where: { workspaceId: fixtures.a.workspaceId, status: 'PENDING' },
      _count: { _all: true },
    });
    const total = pending.reduce((sum, row) => sum + row._count._all, 0);
    expect(pending.map((row) => row.sourceKind).sort()).toEqual(
      expect.arrayContaining(['DOCUMENT', 'MEMBER']),
    );

    const items = await inA((db) => attentionItems(db, session(['brand_brain.review'])));
    const review = items.find((item) => item.kind === 'brand-brain-review-waiting');
    expect(review?.count).toBe(total);
    expect(review?.href).toBe('/brand-brain');
    expect(items.some((item) => item.kind === 'learnings-pending')).toBe(false);
  });

  it('the review row needs brand_brain.review and respects brand scope', async () => {
    const without = await inA((db) => attentionItems(db, session(['brand_brain.read'])));
    expect(without.some((item) => item.kind === 'brand-brain-review-waiting')).toBe(false);
    const scoped = await inA((db) =>
      attentionItems(db, session(['brand_brain.review'], [randomUUID()])),
    );
    expect(scoped.some((item) => item.kind === 'brand-brain-review-waiting')).toBe(false);
    // Workspace B's queue is not A's.
    const bItems = await inB((db) =>
      attentionItems(db, {
        ...session(['brand_brain.review']),
        workspaceId: fixtures.b.workspaceId,
      }),
    );
    const aItems = await inA((db) => attentionItems(db, session(['brand_brain.review'])));
    const bCount = bItems.find((i) => i.kind === 'brand-brain-review-waiting')?.count ?? 0;
    const aCount = aItems.find((i) => i.kind === 'brand-brain-review-waiting')?.count ?? 0;
    expect(bCount).toBe(
      await platform.brandKnowledgeCandidate.count({
        where: { workspaceId: fixtures.b.workspaceId, status: 'PENDING' },
      }),
    );
    expect(aCount).not.toBe(0);
  });

  it('the missing-question row names the first unanswered configured question', async () => {
    const items = await inA((db) =>
      attentionItems(db, session(['brand_brain.read', 'brand_brain.edit'])),
    );
    const missing = items.find((item) => item.kind === 'brand-brain-missing');
    expect(missing).toBeDefined();
    expect(missing?.localizedDetail?.en).toBeTruthy();
    expect(missing?.localizedDetail?.ar).toBeTruthy();
    expect(missing?.href).toMatch(/^\/brand-brain\?brand=[0-9a-f-]{36}&area=[A-Z_]+&question=/);
  });

  it('the missing-question row needs brand_brain.edit and a visible brand', async () => {
    const readOnly = await inA((db) => attentionItems(db, session(['brand_brain.read'])));
    expect(readOnly.some((item) => item.kind === 'brand-brain-missing')).toBe(false);
    const scopedAway = await inA((db) =>
      attentionItems(db, session(['brand_brain.read', 'brand_brain.edit'], [randomUUID()])),
    );
    expect(scopedAway.some((item) => item.kind === 'brand-brain-missing')).toBe(false);
  });

  it('a brand whose every configured question is answered raises no missing row', async () => {
    const brand = await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        name: `Complete ${randomUUID().slice(0, 6)}`,
        slug: `complete-${randomUUID().slice(0, 8)}`,
      },
    });
    const questions = defaultPayload('brand-brain').questions;
    const onboarding = defaultPayload('onboarding');
    const entries: { area: string; itemKey: string }[] = [];
    for (const [area, list] of Object.entries(questions.areas)) {
      for (const question of list as readonly { itemKey: string }[]) {
        entries.push({ area, itemKey: question.itemKey });
      }
    }
    const offersSet = (onboarding as { industries?: unknown }).industries;
    void offersSet;
    await inA(async (db) => {
      for (const entry of entries) {
        await knowledge(db).createItem({
          brandId: brand.id,
          area: entry.area as never,
          itemKey: entry.itemKey,
          title: { en: `Answer ${entry.itemKey}` },
          body: { en: `The answer to ${entry.itemKey}.` },
          actor: { ...actor(), brandScope: [] },
          policy: STALENESS,
        });
      }
    });
    const items = await inA((db) =>
      attentionItems(db, session(['brand_brain.read', 'brand_brain.edit'], [brand.id])),
    );
    expect(items.some((item) => item.kind === 'brand-brain-missing')).toBe(false);
  });
});

/* ======================================================================== */

describe('D13 — the usable-knowledge signature', () => {
  let factId = '';
  beforeAll(async () => {
    const created = await inA((db) =>
      knowledge(db).createItem({
        brandId: fixtures.a.brandId,
        area: 'OFFERS',
        itemKey: `offers.sig-${randomUUID().slice(0, 6)}`,
        title: { en: 'Signature fact' },
        body: { en: 'A fact the signature follows.' },
        actor: actor(),
        policy: STALENESS,
      }),
    );
    factId = created.id;
  });

  const signature = () => inA((db) => knowledgeSignatureFor(db, { brandId: fixtures.a.brandId }));

  it('is the sorted itemId:version hash of exactly the usable facts', async () => {
    const usable = await platform.brandKnowledgeItem.findMany({
      where: {
        brandId: fixtures.a.brandId,
        status: { in: ['ACTIVE', 'STALE'] },
        OR: [{ validUntil: null }, { validUntil: { gte: new Date(Date.UTC(2026, 0, 1)) } }],
      },
      select: { id: true, version: true, validUntil: true },
    });
    const today = new Date(new Date().toISOString().slice(0, 10));
    const live = usable.filter((row) => !row.validUntil || row.validUntil >= today);
    expect(await signature()).toBe(
      knowledgeSignatureOf(live.map((row) => ({ itemId: row.id, version: row.version }))),
    );
  });

  it('does not move for a pending candidate, an unusable fact, or a read', async () => {
    const before = await signature();
    await inA((db) =>
      db.brandKnowledgeCandidate.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sourceKind: 'MEMBER',
          proposedByUserId: fixtures.a.userId,
          area: 'OFFERS',
          itemKey: `offers.pending-${randomUUID().slice(0, 6)}`,
          extractedTitle: { en: 'Pending' },
          extractedBody: { en: 'Only proposed.' },
          confidenceMilli: 900,
          evidence: [],
        },
      }),
    );
    await inA((db) =>
      db.brandKnowledgeItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          area: 'OFFERS',
          memory: 'CANONICAL',
          origin: 'HUMAN',
          status: 'PROPOSED',
          itemKey: `offers.proposed-${randomUUID().slice(0, 6)}`,
          title: { en: 'Proposed' },
          body: { en: 'Not approved.' },
          version: 1,
        },
      }),
    );
    expect(await signature()).toBe(before);
    expect(await signature()).toBe(before);
  });

  it('moves with a new version of a usable fact', async () => {
    const before = await signature();
    await inA((db) =>
      knowledge(db).updateItem({
        itemId: factId,
        title: { en: 'Signature fact, edited' },
        body: { en: 'A fact the signature follows, edited.' },
        actor: actor(),
        policy: STALENESS,
      }),
    );
    expect(await signature()).not.toBe(before);
  });

  it('moves when a usable fact expires', async () => {
    const before = await signature();
    await platform.brandKnowledgeItem.update({
      where: { id: factId },
      data: { validUntil: new Date('2020-01-01T00:00:00.000Z') },
    });
    expect(await signature()).not.toBe(before);
    await platform.brandKnowledgeItem.update({ where: { id: factId }, data: { validUntil: null } });
    expect(await signature()).toBe(before);
  });

  it('moves when a usable fact is archived', async () => {
    const before = await signature();
    await inA((db) => knowledge(db).archiveItem({ itemId: factId, actor: actor() }));
    expect(await signature()).not.toBe(before);
  });

  it('another workspace sees none of this brand’s facts', async () => {
    const fromB = await inB((db) => knowledgeSignatureFor(db, { brandId: fixtures.a.brandId }));
    expect(fromB).toBe(knowledgeSignatureOf([]));
  });

  it('a NULL baseline never alerts; a differing one does; a matching one does not', async () => {
    const current = await signature();
    const changed = (stored: string | null) =>
      inA((db) =>
        brandBrainChangedSince(db, { brandId: fixtures.a.brandId, storedSignature: stored }),
      );
    expect(await changed(null)).toBe(false);
    expect(await changed(current)).toBe(false);
    expect(await changed(knowledgeSignatureOf([]))).toBe(current !== knowledgeSignatureOf([]));
  });
});

/* ------------------------------------------------------------ strategy engine */

const STRATEGY_JSON = JSON.stringify({
  summary: { ar: 'ملخص', en: 'Summary' },
  pillars: [
    {
      name: { ar: 'ركيزة', en: 'Pillar' },
      rationale: { evidenceRefs: [1], text: { ar: 'سبب', en: 'Reason' } },
      sharePercent: 100,
    },
  ],
  channelMix: [
    {
      platformKey: 'linkedin',
      sharePercent: 100,
      rationale: { evidenceRefs: [1], text: { ar: 'سبب', en: 'Reason' } },
    },
  ],
  monthlyPlan: [
    {
      weekNumber: 1,
      theme: { ar: 'إطلاق', en: 'Launch' },
      postsPlanned: 2,
      rationale: { evidenceRefs: [1], text: { ar: 'سبب', en: 'Reason' } },
    },
  ],
});

const model: AiGateway = {
  async execute(): Promise<AiGatewayResult> {
    return {
      requestId: randomUUID(),
      status: 'SUCCEEDED',
      modelKey: 'mock',
      attemptedModelKeys: ['mock'],
      output: { kind: 'text', text: STRATEGY_JSON },
      usage: { promptTokens: 1, completionTokens: 1 },
      creditsChargedMilli: 100n,
      providerCostMicroMinor: 0n,
      failureClass: null,
      failureMessage: null,
      replayed: false,
      latencyMs: 1,
    } as unknown as AiGatewayResult;
  },
  async quote() {
    return { estimateMilli: 1n } as never;
  },
} as unknown as AiGateway;

describe('D13 — the Strategy engine stores the signature it generated on', () => {
  it('writes it on a STRATEGY, and a later approval makes the page alert', async () => {
    const policy = parseAnalyticsPolicy(defaultPayload('analytics'));
    const generated = await inA((db) =>
      new StrategyService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy,
        queries: new AnalyticsQueryService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy,
          registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
        }),
        gateway: model,
        minimumKnowledgeItems: 0,
      }).generate({
        brandId: fixtures.a.brandId,
        period: { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-06-30T23:59:59Z') },
        objective: 'Grow the brand',
        idempotencyKey: `strategy-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        expiresAt: null,
      }),
    );
    const stored = await platform.insight.findUniqueOrThrow({
      where: { id: generated.insight!.id },
    });
    const now = await inA((db) => knowledgeSignatureFor(db, { brandId: fixtures.a.brandId }));
    expect(stored.type).toBe('STRATEGY');
    expect(stored.knowledgeSignature).toBe(now);
    expect(
      await inA((db) =>
        brandBrainChangedSince(db, {
          brandId: fixtures.a.brandId,
          storedSignature: stored.knowledgeSignature,
        }),
      ),
    ).toBe(false);

    // An approved fact changes: the stored baseline no longer matches.
    await inA((db) =>
      knowledge(db).createItem({
        brandId: fixtures.a.brandId,
        area: 'PROOF_POINTS',
        itemKey: `proof.new-${randomUUID().slice(0, 6)}`,
        title: { en: 'A new proof point' },
        body: { en: 'Approved after the strategy.' },
        actor: actor(),
        policy: STALENESS,
      }),
    );
    expect(
      await inA((db) =>
        brandBrainChangedSince(db, {
          brandId: fixtures.a.brandId,
          storedSignature: stored.knowledgeSignature,
        }),
      ),
    ).toBe(true);
    // And nothing about reading it wrote to the strategy.
    const reread = await platform.insight.findUniqueOrThrow({ where: { id: stored.id } });
    expect(reread.knowledgeSignature).toBe(stored.knowledgeSignature);
    expect(reread.updatedAt.getTime()).toBe(stored.updatedAt.getTime());
  });

  it('older insights have no signature', async () => {
    const row = await platform.insight.findUniqueOrThrow({ where: { id: fixtures.a.insightId } });
    expect(row.knowledgeSignature).toBeNull();
  });
});

/* ======================================================================== */

describe('D13 — acknowledge re-baselines the accepted strategy (owner decision Option 1)', () => {
  const changedSince = (stored: string | null) =>
    inA((db) =>
      brandBrainChangedSince(db, { brandId: fixtures.a.brandId, storedSignature: stored }),
    );
  const acknowledgements = (insightId: string) =>
    platform.auditEvent.findMany({
      where: { resourceId: insightId, action: 'strategy.knowledge_change.acknowledged' },
      orderBy: { occurredAt: 'asc' },
    });

  /** An ACCEPTED strategy whose stored baseline is stale: the alert is showing. */
  async function staleStrategy(): Promise<{ id: string; stored: string }> {
    const stored = knowledgeSignatureOf([{ itemId: randomUUID(), version: 1 }]);
    const insight = await inA((db) =>
      db.insight.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          type: 'STRATEGY',
          status: 'ACCEPTED',
          basis: 'BRAND_CONTEXT',
          title: { en: 'Strategy' },
          body: {},
          periodStart: new Date('2026-09-01T00:00:00Z'),
          periodEnd: new Date('2026-09-30T00:00:00Z'),
          generatedByUserId: fixtures.a.userId,
          knowledgeSignature: stored,
        },
      }),
    );
    expect(await changedSince(stored)).toBe(true);
    return { id: insight.id, stored };
  }

  const acknowledge = (insightId: string, brandScope: readonly string[] = []) =>
    inA((db) =>
      acknowledgeKnowledgeChange(db, {
        workspaceId: fixtures.a.workspaceId,
        insightId,
        actorUserId: fixtures.a.userId,
        brandScope,
      }),
    );

  it('clears the alert, audited with the previous and the new baseline', async () => {
    const { id, stored } = await staleStrategy();
    const result = await acknowledge(id);
    expect(result.acknowledged).toBe(true);
    const row = await platform.insight.findUniqueOrThrow({ where: { id } });
    const current = await inA((db) => knowledgeSignatureFor(db, { brandId: fixtures.a.brandId }));
    expect(row.knowledgeSignature).toBe(current);
    expect(await changedSince(row.knowledgeSignature)).toBe(false);

    const events = await acknowledgements(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'USER',
      actorId: fixtures.a.userId,
      resourceType: 'Insight',
      brandId: fixtures.a.brandId,
      before: { knowledgeBaseline: stored },
      after: { knowledgeBaseline: current },
    });
  });

  it('acknowledging an already-current baseline is a no-op — no write, no audit', async () => {
    const { id } = await staleStrategy();
    await acknowledge(id);
    const before = await platform.insight.findUniqueOrThrow({ where: { id } });
    const again = await acknowledge(id);
    expect(again.acknowledged).toBe(false);
    const after = await platform.insight.findUniqueOrThrow({ where: { id } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await acknowledgements(id)).toHaveLength(1);
  });

  it('a later change to the usable facts raises the alert again', async () => {
    const { id } = await staleStrategy();
    await acknowledge(id);
    const row = await platform.insight.findUniqueOrThrow({ where: { id } });
    await inA((db) =>
      knowledge(db).createItem({
        brandId: fixtures.a.brandId,
        area: 'PROOF_POINTS',
        itemKey: `proof.after-ack-${randomUUID().slice(0, 6)}`,
        title: { en: 'Approved after the acknowledgement' },
        body: { en: 'A new usable fact.' },
        actor: actor(),
        policy: STALENESS,
      }),
    );
    expect(await changedSince(row.knowledgeSignature)).toBe(true);
  });

  it('a strategy with no baseline, another workspace or another brand scope: nothing written', async () => {
    const legacy = await inA((db) =>
      db.insight.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          type: 'STRATEGY',
          status: 'ACCEPTED',
          basis: 'BRAND_CONTEXT',
          title: { en: 'Old strategy' },
          body: {},
          periodStart: new Date('2026-08-01T00:00:00Z'),
          periodEnd: new Date('2026-08-31T00:00:00Z'),
        },
      }),
    );
    expect((await acknowledge(legacy.id)).acknowledged).toBe(false);
    expect(
      (await platform.insight.findUniqueOrThrow({ where: { id: legacy.id } })).knowledgeSignature,
    ).toBeNull();

    const { id, stored } = await staleStrategy();
    await expect(acknowledge(id, [randomUUID()])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      inB((db) =>
        acknowledgeKnowledgeChange(db, {
          workspaceId: fixtures.b.workspaceId,
          insightId: id,
          actorUserId: fixtures.b.userId,
          brandScope: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await platform.insight.findUniqueOrThrow({ where: { id } })).knowledgeSignature).toBe(
      stored,
    );
  });

  it('the route needs strategy.manage: refused without it, re-baselines with it', async () => {
    const { id, stored } = await staleStrategy();
    expect(
      (await post('/v1/strategy/acknowledge-knowledge', tokens.readOnly, { insightId: id })).status,
    ).toBe(404);
    expect(
      (await post('/v1/strategy/acknowledge-knowledge', tokens.none, { insightId: id })).status,
    ).toBe(404);
    expect((await platform.insight.findUniqueOrThrow({ where: { id } })).knowledgeSignature).toBe(
      stored,
    );
    expect(await acknowledgements(id)).toHaveLength(0);

    const response = await post('/v1/strategy/acknowledge-knowledge', tokens.manage, {
      insightId: id,
    });
    expect(response.status).toBe(200);
    expect(response.body['acknowledged']).toBe(true);
    expect(await acknowledgements(id)).toHaveLength(1);
    const again = await post('/v1/strategy/acknowledge-knowledge', tokens.manage, {
      insightId: id,
    });
    expect(again.body['acknowledged']).toBe(false);
    expect(await acknowledgements(id)).toHaveLength(1);
  });
});

/* ======================================================================== */

describe('the Strategy display lists — the usable rule, not ACTIVE only', () => {
  it('shows usable ACTIVE and STALE, hides expired, archived and goals', async () => {
    const tag = randomUUID().slice(0, 6);
    const make = (key: string, status: 'ACTIVE' | 'STALE' | 'ARCHIVED', validUntil: Date | null) =>
      inA((db) =>
        db.brandKnowledgeItem.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            area: 'AUDIENCE',
            memory: 'CANONICAL',
            origin: 'HUMAN',
            status,
            itemKey: `${key}-${tag}`,
            title: { en: key },
            body: { en: key },
            version: 1,
            validUntil,
          },
          select: { id: true },
        }),
      );
    const active = await make('audience.active', 'ACTIVE', null);
    const stale = await make('audience.stale', 'STALE', null);
    const expired = await make('audience.expired', 'ACTIVE', new Date('2020-01-01T00:00:00Z'));
    const archived = await make('audience.archived', 'ARCHIVED', null);
    const goal = await inA((db) =>
      db.brandKnowledgeItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          area: 'STRATEGY',
          memory: 'STRATEGY',
          origin: 'HUMAN',
          status: 'ACTIVE',
          itemKey: `goal.p2c4-${tag}`,
          title: { en: 'goal' },
          body: { en: 'goal' },
          version: 1,
        },
        select: { id: true },
      }),
    );

    const shown = (
      await inA((db) =>
        usableFactsForDisplay(db, {
          brandId: fixtures.a.brandId,
          areas: ['AUDIENCE', 'STRATEGY'],
          take: 200,
        }),
      )
    ).map((row) => row.id);
    expect(shown).toContain(active.id);
    expect(shown).toContain(stale.id);
    expect(shown).not.toContain(expired.id);
    expect(shown).not.toContain(archived.id);
    expect(shown).not.toContain(goal.id);
  });
});
