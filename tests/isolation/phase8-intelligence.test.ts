import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { AnalyticsQueryService, createAnalyticsRegistry, parseAnalyticsPolicy } from '@brandspace/analytics';
import { defaultPayload } from '@brandspace/config';
import { BrandKnowledgeService } from '@brandspace/brand-brain';
import { LearningWriteBackService, StrategyService } from '@brandspace/intelligence';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * MARKETING INTELLIGENCE, ON REAL POSTGRESQL — Phase 8 (AC-30.1, AC-30.4, AC-30.5).
 *
 * WHAT THIS SUITE IS ABOUT. The last leg of the Phase 8 exit journey is
 * Analytics → Marketing Intelligence → accepted learning back into Brand Brain,
 * and every step of it reads or writes something that belongs to exactly one
 * brand in exactly one workspace. So the properties are:
 *
 *   1. CONTENT-GAP ANALYSIS IS BRAND-SCOPED IN THE QUERY. A brand outside the
 *      member's scope is refused before anything is read, and the refusal is
 *      shaped like a miss.
 *   2. IT STATES ITS BASIS, and the basis is always something in this
 *      workspace. There is no external market source and nothing here invents
 *      one.
 *   3. A REPEATED REQUEST REPLAYS RATHER THAN RE-CHARGING. An analysis costs
 *      credits; a double submission must not cost two.
 *   4. THE WRITE-BACK PROPOSES, IT DOES NOT WRITE. A learning lands as a
 *      PENDING candidate in the Brand Brain review queue with its provenance —
 *      the brand's own approved knowledge is untouched until a human accepts it
 *      there (D-150).
 *   5. ANOTHER TENANT'S INSIGHT IS NOT A DOOR INTO THIS ONE. A foreign insight
 *      id proposes nothing and is indistinguishable from a fabricated one.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

/** A SECOND brand in workspace A, so a narrowed scope has something to exclude. */
let otherBrandId: string;

const analyticsPolicy = () => parseAnalyticsPolicy(defaultPayload('analytics'));

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const period = {
  start: new Date('2026-06-01T00:00:00.000Z'),
  end: new Date('2026-06-30T00:00:00.000Z'),
};

/**
 * A CONTENT-GAP DOCUMENT THAT CARRIES NO MEASURED FIGURE.
 *
 * Deliberately numeral-free. The grounding validator refuses prose containing a
 * numeral that is not in the evidence, and this suite is about scoping and the
 * write-back rather than about grounding — which has its own suite. Keeping the
 * text free of numbers means a change to the evidence fixtures can never make
 * these tests fail for the wrong reason.
 */
const GAP_JSON = JSON.stringify({
  summary: {
    ar: 'هناك محاور أعلنتها العلامة ولم تنشر حولها.',
    en: 'There are pillars this brand declared and has not published against.',
  },
  gaps: [
    {
      title: { ar: 'محور غير مُغطّى', en: 'An uncovered pillar' },
      rationale: {
        evidenceRefs: [1],
        text: {
          ar: 'المحور معتمد في عقل العلامة ولا يوجد محتوى منشور حوله.',
          en: 'The pillar is approved in Brand Brain and nothing has been published against it.',
        },
      },
      suggestedAction: {
        ar: 'خطّط محتوى حول هذا المحور.',
        en: 'Plan content against this pillar.',
      },
    },
  ],
});

interface GatewayCalls {
  readonly executes: { idempotencyKey: string }[];
  readonly recorded: Map<string, AiGatewayResult>;
}

function calls(): GatewayCalls {
  return { executes: [], recorded: new Map() };
}

/**
 * The gateway, stubbed with the REAL replay semantics.
 *
 * A replay costs nothing, exactly as the live gateway's does — which is the
 * property test 3 below is actually about, so faking it away would make that
 * test prove nothing.
 */
function stubGateway(record: GatewayCalls, text: string): AiGateway {
  return {
    async execute(input: { idempotencyKey: string }): Promise<AiGatewayResult> {
      record.executes.push({ idempotencyKey: input.idempotencyKey });
      const existing = record.recorded.get(input.idempotencyKey);
      if (existing) return { ...existing, replayed: true, creditsChargedMilli: 0n };
      const fresh: AiGatewayResult = {
        requestId: randomUUID(),
        status: 'SUCCEEDED',
        modelKey: 'mock',
        attemptedModelKeys: ['mock'],
        output: { kind: 'text', text },
        usage: { promptTokens: 1, completionTokens: 1 },
        creditsChargedMilli: 100n,
        providerCostMicroMinor: 0n,
        failureClass: null,
        failureMessage: null,
        replayed: false,
        latencyMs: 1,
      };
      record.recorded.set(input.idempotencyKey, fresh);
      return fresh;
    },
    async quote() {
      return { estimateMilli: 0n } as never;
    },
  } as unknown as AiGateway;
}

function strategyService(db: TenantScopedClient, record: GatewayCalls): StrategyService {
  return new StrategyService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: analyticsPolicy(),
    queries: new AnalyticsQueryService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: analyticsPolicy(),
      registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
    }),
    gateway: stubGateway(record, GAP_JSON),
    // The grounding FLOOR is a product rule with its own suite; this one is
    // about scope and the write-back, so the floor stays out of its way.
    minimumKnowledgeItems: 0,
  });
}

function learningService(db: TenantScopedClient): LearningWriteBackService {
  return new LearningWriteBackService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: analyticsPolicy(),
    queries: new AnalyticsQueryService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: analyticsPolicy(),
      registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
    }),
    knowledge: new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }),
  });
}

/** The AppError a promise rejected with, as a plain shape. */
async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
    throw new Error('expected a refusal, but the call succeeded');
  } catch (error: unknown) {
    const shaped = error as { code?: unknown; message?: unknown };
    return {
      code: typeof shaped.code === 'string' ? shaped.code : 'UNKNOWN',
      message: typeof shaped.message === 'string' ? shaped.message : '',
    };
  }
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);

  otherBrandId = await inA(async (db) => {
    const brand = await db.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        name: 'The other brand',
        slug: `other-${randomUUID().slice(0, 8)}`,
      },
    });
    return brand.id;
  });
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('content-gap analysis is brand-scoped in the query', () => {
  it('produces a CONTENT_GAP insight for a brand inside the scope', async () => {
    const record = calls();
    const result = await inA((db) =>
      strategyService(db, record).analyseContentGaps({
        brandId: fixtures.a.brandId,
        period,
        objective: 'Our presence this quarter',
        idempotencyKey: `gap-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        expiresAt: null,
      }),
    );

    expect(result.insight?.type).toBe('CONTENT_GAP');
    expect(result.insight?.brandId).toBe(fixtures.a.brandId);
    expect(result.replayed).toBe(false);
  });

  it('states a basis, and it is one this workspace can actually check', async () => {
    const record = calls();
    const result = await inA((db) =>
      strategyService(db, record).analyseContentGaps({
        brandId: fixtures.a.brandId,
        period,
        objective: 'What are we not covering',
        idempotencyKey: `gap-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        expiresAt: null,
      }),
    );

    // There is no external market source and none of these names one: each is
    // this brand's own performance, its own approved knowledge, or its own
    // publishing history (D-18, D-19).
    expect(['OWN_PERFORMANCE', 'BRAND_CONTEXT', 'CONTENT_HISTORY', 'MIXED']).toContain(
      result.insight?.basis,
    );
  });

  it('refuses a brand outside the member scope, and never reads it', async () => {
    const record = calls();
    const refusal = await failure(
      inA((db) =>
        strategyService(db, record).analyseContentGaps({
          brandId: otherBrandId,
          period,
          objective: 'Somebody else’s brand',
          idempotencyKey: `gap-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [fixtures.a.brandId],
          planKey: null,
          expiresAt: null,
        }),
      ),
    );

    expect(refusal.code).toBe('NOT_FOUND');
    // AND NOTHING WAS GENERATED. A refusal after the model has been paid for is
    // not a refusal.
    expect(record.executes).toHaveLength(0);
  });

  it("refuses another TENANT's brand id exactly as it refuses a fabricated one", async () => {
    const record = calls();
    const stranger = await failure(
      inA((db) =>
        strategyService(db, record).analyseContentGaps({
          brandId: fixtures.b.brandId,
          period,
          objective: 'A brand in another workspace',
          idempotencyKey: `gap-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [fixtures.a.brandId],
          planKey: null,
          expiresAt: null,
        }),
      ),
    );
    const invented = await failure(
      inA((db) =>
        strategyService(db, record).analyseContentGaps({
          brandId: randomUUID(),
          period,
          objective: 'A brand that never existed',
          idempotencyKey: `gap-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [fixtures.a.brandId],
          planKey: null,
          expiresAt: null,
        }),
      ),
    );

    expect(stranger).toEqual(invented);
    expect(record.executes).toHaveLength(0);
  });
});

describe('a repeated request replays rather than re-charging', () => {
  it('returns the first analysis, spends nothing, and creates no second insight', async () => {
    const record = calls();
    const key = `gap-${randomUUID()}`;
    const input = {
      brandId: fixtures.a.brandId,
      period,
      objective: 'The same question, twice',
      idempotencyKey: key,
      actorUserId: fixtures.a.userId,
      planKey: null,
      actorBrandScope: [] as readonly string[],
      expiresAt: null,
    };

    const first = await inA((db) => strategyService(db, record).analyseContentGaps(input));
    const second = await inA((db) => strategyService(db, record).analyseContentGaps(input));

    expect(second.replayed).toBe(true);
    expect(second.insight?.id).toBe(first.insight?.id);
    expect(second.creditsChargedMilli).toBe(0n);

    const rows = await inA((db) =>
      db.insight.count({ where: { idempotencyKey: key, type: 'CONTENT_GAP' } }),
    );
    expect(rows).toBe(1);
  });

  it('a strategy key does NOT replay as a content-gap analysis', async () => {
    const record = calls();
    const key = `shared-${randomUUID()}`;
    await inA((db) =>
      db.insight.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          type: 'STRATEGY',
          status: 'NEW',
          basis: 'OWN_PERFORMANCE',
          title: { ar: 'استراتيجية', en: 'A strategy' },
          body: {},
          periodStart: period.start,
          periodEnd: period.end,
          generatedByUserId: fixtures.a.userId,
          idempotencyKey: key,
        },
      }),
    );

    const result = await inA((db) =>
      strategyService(db, record).analyseContentGaps({
        brandId: fixtures.a.brandId,
        period,
        objective: 'A different kind of question',
        idempotencyKey: key,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        expiresAt: null,
      }),
    );

    // A NEW insight, of the right type. Replaying across types would hand a
    // customer a strategy where they asked what was missing.
    expect(result.replayed).toBe(false);
    expect(result.insight?.type).toBe('CONTENT_GAP');
  });
});

describe('the learning loop proposes, and never writes into the brand', () => {
  async function anInsightFor(brandId: string): Promise<string> {
    return inA(async (db) => {
      const insight = await db.insight.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId,
          type: 'ANALYTICS_EXPLANATION',
          status: 'ACCEPTED',
          basis: 'OWN_PERFORMANCE',
          title: { ar: 'شرح', en: 'An explanation' },
          body: {},
          periodStart: period.start,
          periodEnd: period.end,
          generatedByUserId: fixtures.a.userId,
          idempotencyKey: `insight-${randomUUID()}`,
        },
      });
      return insight.id;
    });
  }

  it('leaves the brand’s APPROVED knowledge untouched', async () => {
    const insightId = await anInsightFor(fixtures.a.brandId);
    const before = await inA((db) =>
      db.brandKnowledgeItem.count({ where: { brandId: fixtures.a.brandId } }),
    );

    await inA((db) => learningService(db).proposeFromInsight({ insightId, actorBrandScope: [] }));

    const after = await inA((db) =>
      db.brandKnowledgeItem.count({ where: { brandId: fixtures.a.brandId } }),
    );
    // WHATEVER WAS DERIVED, nothing became a brand fact. The loop closes when a
    // human accepts a candidate in the review queue, and not before (D-150).
    expect(after).toBe(before);
  });

  it('anything it does propose lands PENDING, in the existing review queue', async () => {
    const insightId = await anInsightFor(fixtures.a.brandId);
    const result = await inA((db) =>
      learningService(db).proposeFromInsight({ insightId, actorBrandScope: [] }),
    );

    for (const proposal of result.proposed) {
      const candidate = await inA((db) =>
        db.brandKnowledgeCandidate.findFirst({ where: { id: proposal.candidateId } }),
      );
      expect(candidate?.status).toBe('PENDING');
      expect(candidate?.brandId).toBe(fixtures.a.brandId);
      // PROVENANCE, so a reviewer can open what it rests on.
      expect(candidate?.insightId).toBe(insightId);
    }
  });

  it('an insight outside the member scope proposes NOTHING', async () => {
    const insightId = await anInsightFor(otherBrandId);
    const result = await inA((db) =>
      learningService(db).proposeFromInsight({
        insightId,
        actorBrandScope: [fixtures.a.brandId],
      }),
    );

    expect(result.proposed).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('insight_not_found');
  });

  it("another TENANT's insight is indistinguishable from one that never existed", async () => {
    const foreign = await withWorkspace(
      fixtures.b.workspaceId,
      async (db) => {
        const insight = await db.insight.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            type: 'ANALYTICS_EXPLANATION',
            status: 'NEW',
            basis: 'OWN_PERFORMANCE',
            title: { ar: 'شرح', en: 'An explanation' },
            body: {},
            periodStart: period.start,
            periodEnd: period.end,
            generatedByUserId: fixtures.b.userId,
            idempotencyKey: `foreign-${randomUUID()}`,
          },
        });
        return insight.id;
      },
      { prisma: app },
    );

    const stranger = await inA((db) =>
      learningService(db).proposeFromInsight({
        insightId: foreign as string,
        actorBrandScope: [],
      }),
    );
    const invented = await inA((db) =>
      learningService(db).proposeFromInsight({ insightId: randomUUID(), actorBrandScope: [] }),
    );

    expect(stranger).toEqual(invented);
    expect(stranger.proposed).toHaveLength(0);
  });
});
