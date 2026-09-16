import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  AiGateway,
  type AiConfiguration,
  type AiFailureClass,
  type AiProviderAdapter,
  type TextResult,
} from '@brandspace/ai-gateway';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';
import {
  AnalyticsInsightService,
  AnalyticsQueryService,
  createAnalyticsRegistry,
  parseAnalyticsPolicy,
  type AnalyticsPolicy,
} from '@brandspace/analytics';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Phase 7 — GROUNDED AI INSIGHTS, against real PostgreSQL and the real gateway.
 *
 * WHAT THIS PROVES THAT A UNIT TEST CANNOT. The grounding rules themselves are
 * pure functions and are exercised exhaustively in `tests/unit`. What needs a
 * database and a gateway is the SHAPE OF THE WHOLE TRANSACTION:
 *
 *   - a refusal below the evidence floor costs NOTHING — no gateway call, no
 *     reservation, no credit movement. A customer told "there is not enough data
 *     yet" must not be billed to be told.
 *   - the evidence is persisted as ROWS WITH MEASURED VALUES, independently of
 *     the prose, so the figures a customer sees come from the observations and
 *     never from a numeral the model wrote.
 *   - a retry replays rather than re-generating, so a lost response cannot bill
 *     twice.
 *   - none of it is reachable across a tenant or a brand boundary.
 */

const CREDIT_POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

const MODEL_KEY = 'mock-fast';
const TASK_KEY = 'analytics.explain';

function configuration(): AiConfiguration {
  return {
    providers: [
      {
        key: 'mock',
        baseUrl: 'https://mock.invalid',
        apiKeySecretRef: null,
        status: 'active',
        timeoutMs: 30_000,
      },
    ],
    models: [
      {
        key: MODEL_KEY,
        providerKey: 'mock',
        modality: 'text',
        qualityTier: 'fast',
        status: 'available',
        disableSwitch: false,
      },
    ],
    costBases: [
      {
        modelKey: MODEL_KEY,
        inputCostPerUnitMicroMinor: 15_000,
        outputCostPerUnitMicroMinor: 60_000,
        costUnit: '1k_tokens',
        costCurrency: 'USD',
      },
    ],
    routingRules: [
      {
        taskKey: TASK_KEY,
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: MODEL_KEY,
        fallbackModelKeys: [],
        timeoutMs: 5_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.2,
          maxOutputTokens: 512,
          promptTemplateVersion: 1,
          persistOutput: false,
          outputRetentionDays: null,
        },
        retryPolicy: { maxAttempts: 1, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
    ],
    creditRules: [
      {
        taskKey: TASK_KEY,
        modelKey: MODEL_KEY,
        baseMilliCredits: 100,
        perUnitMilliCredits: 50,
        unit: '1k_tokens',
      },
    ],
    budgets: {
      defaults: {
        creditsPerDayMilli: null,
        creditsPerMonthMilli: null,
        maxConcurrentRequests: null,
      },
      perPlan: [],
    },
  };
}

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AnalyticsPolicy;
let gateway: AiGateway;

/**
 * A SCRIPTED PROVIDER, and the reason this suite needs one.
 *
 * The approved mock (D-13 deferred vendor selection, so it is the only adapter
 * that exists) SELECTS from the material it is handed rather than generating,
 * and it is deliberately NOT steerable from a prompt — property 3 of
 * `MockProviderAdapter`, which exists so the mock cannot become a
 * prompt-injection surface. It therefore cannot emit the JSON envelope
 * `explanationSchema` requires, and in a browser the grounded path reaches the
 * honest refusal instead of a persisted insight. That outcome is asserted in the
 * end-to-end suite, exactly as the Content Studio's is.
 *
 * What CANNOT be proven that way is the success branch and the fabrication
 * branch, and both are the point of this phase. So the service is driven through
 * an adapter whose answer the test chooses — which also lets the test hand the
 * service a response that CITES A ROW THAT DOES NOT EXIST, something no honest
 * provider would produce on demand.
 */
let nextOutput = '';
let callCount = 0;

class ScriptedTextAdapter implements AiProviderAdapter {
  readonly key = 'mock';
  readonly supportedModalities = ['text'] as const;

  async testConnection() {
    return { ok: true, latencyMs: 0, message: 'scripted' };
  }

  async generateText(request: {
    modelKey: string;
    prompt: string;
    untrustedContext?: readonly string[] | undefined;
  }): Promise<TextResult> {
    callCount += 1;
    const contextChars = (request.untrustedContext ?? []).reduce((n, c) => n + c.length, 0);
    return {
      text: nextOutput,
      usage: {
        promptTokens: Math.ceil((request.prompt.length + contextChars) / 4),
        completionTokens: Math.ceil(nextOutput.length / 4),
      },
      modelKey: request.modelKey,
    };
  }

  classifyError(): AiFailureClass {
    return 'UNKNOWN';
  }
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAnalyticsPolicy(defaultPayload('analytics'));

  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  gateway = new AiGateway({
    prisma: platform,
    ledger: new CreditLedgerService({ prisma: platform, policy: CREDIT_POLICY }),
    adapters: new Map<string, AiProviderAdapter>([['mock', new ScriptedTextAdapter()]]),
    configuration: { load: async () => configuration() },
    credentials: { resolve: async () => null },
    environment: 'DEVELOPMENT',
  });
  baselineOpenReservations = await platform.creditReservation.count({
    where: { workspaceId: fixtures.a.workspaceId, status: 'OPEN' },
  });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const PERIOD = {
  start: new Date('2026-08-01T00:00:00.000Z'),
  end: new Date('2026-10-01T00:00:00.000Z'),
};

function insights(db: TenantScopedClient): AnalyticsInsightService {
  return new AnalyticsInsightService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy,
    queries: new AnalyticsQueryService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy,
      registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
    }),
    gateway,
  });
}

/** Give the brand enough measured figures to clear the evidence floor. */
async function seedObservations(count: number): Promise<void> {
  const metrics = ['impressions', 'reach', 'engagements', 'likes', 'comments', 'shares', 'clicks'];
  await inA(async (db) => {
    for (let index = 0; index < count; index += 1) {
      const metricKey = metrics[index % metrics.length] as string;
      const day = 2 + Math.floor(index / metrics.length);
      const periodStart = new Date(Date.UTC(2026, 8, day));
      await db.metricObservation.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          socialConnectionId: fixtures.a.socialConnectionId,
          provider: 'LINKEDIN',
          subjectType: 'ACCOUNT',
          subjectExternalId: fixtures.a.socialExternalAccountId,
          metricKey,
          granularity: 'DAY',
          periodStart,
          periodEnd: new Date(periodStart.getTime() + 86_400_000),
          value: BigInt(1_000 + index * 37),
          unit: 'COUNT',
          observedAt: new Date(periodStart.getTime() + 86_400_000),
          sourceKind: 'PROVIDER',
          sourceVersion: 'grounding-fixture-1',
          observationKey: `grounding-${randomUUID()}`,
        },
      });
    }
  });
}

/**
 * A response that cites the evidence it was given and quotes nothing else.
 *
 * NO NUMERALS AT ALL in the prose, deliberately: the figures a customer reads
 * are rendered from the persisted evidence rows, not from the model's sentence,
 * so a correct answer has no reason to restate them.
 */
function groundedResponse(): string {
  return JSON.stringify({
    summary: {
      ar: 'تحسن الأداء خلال الفترة.',
      en: 'Performance improved over the period.',
    },
    claims: [
      { evidenceRefs: [1], text: { ar: 'ارتفع الظهور.', en: 'Impressions rose.' } },
      { evidenceRefs: [2], text: { ar: 'ارتفع الوصول.', en: 'Reach rose.' } },
    ],
    notableChanges: [],
    recommendations: [{ evidenceRefs: [1], text: { ar: 'واصل النشر.', en: 'Keep publishing.' } }],
  });
}

/** The same response, with a citation to a row the package does not contain. */
function fabricatedCitationResponse(): string {
  return JSON.stringify({
    summary: { ar: 'ملخص', en: 'Summary' },
    claims: [{ evidenceRefs: [999], text: { ar: 'ادعاء مختلق.', en: 'A fabricated claim.' } }],
    notableChanges: [],
    recommendations: [],
  });
}

/** A response that cites correctly and then states a figure nobody measured. */
function fabricatedNumberResponse(): string {
  return JSON.stringify({
    summary: { ar: 'ملخص', en: 'Summary' },
    claims: [
      {
        evidenceRefs: [1],
        text: { ar: 'بلغ الظهور 987654 مرة.', en: 'Impressions reached 987654.' },
      },
    ],
    notableChanges: [],
    recommendations: [],
  });
}

async function walletBalance(): Promise<bigint> {
  const wallet = await platform.creditWallet.findUniqueOrThrow({
    where: { workspaceId: fixtures.a.workspaceId },
  });
  return wallet.balanceMilliCredits;
}

/**
 * Open reservations for this workspace.
 *
 * COMPARED AS A DELTA, never against zero: the shared fixtures provision one
 * OPEN reservation of their own so the credit tables are not empty, and a test
 * that demanded zero would be asserting the fixture rather than this phase.
 */
async function openReservations(): Promise<number> {
  return platform.creditReservation.count({
    where: { workspaceId: fixtures.a.workspaceId, status: 'OPEN' },
  });
}

let baselineOpenReservations = 0;

describe('a refusal below the evidence floor is FREE', () => {
  it('generates nothing, calls no provider, and moves no credits', async () => {
    /*
     * THE FIXTURE BRAND STARTS WITH ONE OBSERVATION, which is below the
     * configured `explain.minEvidenceItems` floor. The refusal must therefore
     * happen BEFORE the gateway is reached — not after a reservation, and
     * certainly not after a charge.
     */
    callCount = 0;
    const before = await walletBalance();

    const result = await inA((db) =>
      insights(db).explain({
        brandId: fixtures.a.brandId,
        scope: { brandId: fixtures.a.brandId },
        period: PERIOD,
        idempotencyKey: `floor-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [fixtures.a.brandId],
        expiresAt: null,
      }),
    );

    expect(result.insufficientData).toBe(true);
    expect(result.insight).toBeNull();
    expect(result.aiRequestId).toBeNull();
    expect(result.creditsChargedMilli).toBe(0n);
    expect(await walletBalance()).toBe(before);
    expect(await openReservations()).toBe(baselineOpenReservations);
    expect(callCount).toBe(0);
  });
});

describe('a grounded explanation, end to end', () => {
  it('persists EVIDENCE ROWS carrying measured values, not prose', async () => {
    callCount = 0;
    await seedObservations(12);
    nextOutput = groundedResponse();

    const result = await inA((db) =>
      insights(db).explain({
        brandId: fixtures.a.brandId,
        scope: { brandId: fixtures.a.brandId },
        period: PERIOD,
        idempotencyKey: `explain-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [fixtures.a.brandId],
        expiresAt: null,
      }),
    );

    expect(result.insufficientData).toBe(false);
    expect(result.insight).not.toBeNull();
    expect(result.evidence.length).toBeGreaterThanOrEqual(policy.explain.minEvidenceItems);

    const stored = await inA((db) =>
      db.insightEvidence.findMany({
        where: { insightId: result.insight?.id ?? '' },
        orderBy: { ordinal: 'asc' },
      }),
    );
    expect(stored.length).toBe(result.evidence.length);

    /*
     * THE PROPERTY THE WHOLE DESIGN RESTS ON. Every METRIC evidence row carries
     * the metric key, the value, the unit and the window — on the ROW, copied
     * from the observation. The UI renders figures from these, so there is no
     * path by which a numeral the model wrote reaches a chart.
     */
    for (const row of stored) {
      expect(row.workspaceId).toBe(fixtures.a.workspaceId);
      expect(row.brandId).toBe(fixtures.a.brandId);
      expect(row.labelKey, `ordinal ${row.ordinal} labelKey`).toBeTruthy();
      if (row.kind === 'METRIC' || row.kind === 'METRIC_COMPARISON') {
        expect(row.metricKey, `ordinal ${row.ordinal} metricKey`).toBeTruthy();
        expect(row.value, `ordinal ${row.ordinal} value`).not.toBeNull();
        expect(row.unit, `ordinal ${row.ordinal} unit`).not.toBeNull();
        expect(row.periodStart, `ordinal ${row.ordinal} periodStart`).not.toBeNull();
      }
    }

    // And the ordinals are contiguous from 1 — the handles the prose cites.
    expect(stored.map((row) => row.ordinal)).toEqual(stored.map((_, index) => index + 1));
  });

  it('every stored metric evidence row matches a real observation', async () => {
    const insight = await inA((db) =>
      db.insight.findFirstOrThrow({
        where: { type: 'ANALYTICS_EXPLANATION', brandId: fixtures.a.brandId },
        orderBy: { createdAt: 'desc' },
        include: { evidence: true },
      }),
    );

    for (const row of insight.evidence) {
      if (!row.metricObservationId) continue;
      const observation = await inA((db) =>
        db.metricObservation.findFirst({ where: { id: row.metricObservationId ?? '' } }),
      );
      expect(observation, `evidence ${row.ordinal} points at a real observation`).not.toBeNull();
      expect(observation?.workspaceId).toBe(fixtures.a.workspaceId);
      expect(row.value).toBe(observation?.value);
      expect(row.metricKey).toBe(observation?.metricKey);
    }
  });

  it('the insight records the AI request it came from, so the cost is traceable', async () => {
    const insight = await inA((db) =>
      db.insight.findFirstOrThrow({
        where: { type: 'ANALYTICS_EXPLANATION', brandId: fixtures.a.brandId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(insight.aiRequestId).not.toBeNull();
    expect(insight.basis).toBe('OWN_PERFORMANCE');
  });

  it('a retry with the same key REPLAYS and makes no second provider call', async () => {
    callCount = 0;
    nextOutput = groundedResponse();
    const key = `replay-${randomUUID()}`;

    const first = await inA((db) =>
      insights(db).explain({
        brandId: fixtures.a.brandId,
        scope: { brandId: fixtures.a.brandId },
        period: PERIOD,
        idempotencyKey: key,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [fixtures.a.brandId],
        expiresAt: null,
      }),
    );
    const callsAfterFirst = callCount;
    const balanceAfterFirst = await walletBalance();

    const second = await inA((db) =>
      insights(db).explain({
        brandId: fixtures.a.brandId,
        scope: { brandId: fixtures.a.brandId },
        period: PERIOD,
        idempotencyKey: key,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [fixtures.a.brandId],
        expiresAt: null,
      }),
    );

    expect(second.replayed).toBe(true);
    expect(second.insight?.id).toBe(first.insight?.id);
    expect(second.creditsChargedMilli).toBe(0n);
    // NO SECOND PROVIDER CALL AND NO SECOND CHARGE. A lost response is the
    // ordinary case on a mobile connection, and it must not cost twice.
    expect(callCount).toBe(callsAfterFirst);
    expect(await walletBalance()).toBe(balanceAfterFirst);
    expect(await openReservations()).toBe(baselineOpenReservations);
  });
});

describe('an insight is unreachable outside its brand and its tenant', () => {
  it("naming a brand outside the caller's scope refuses BEFORE the replay path", async () => {
    /*
     * ORDERING MATTERS HERE (the F-74 ordering). The replay path RETURNS an
     * insight, so a scope check placed after it would let a member learn that
     * an insight for a brand they may not see exists.
     */
    await expect(
      inA((db) =>
        insights(db).explain({
          brandId: fixtures.b.brandId,
          scope: { brandId: fixtures.b.brandId },
          period: PERIOD,
          idempotencyKey: `foreign-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [fixtures.a.brandId],
          expiresAt: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("another tenant's insight id is not readable, and neither is its evidence", async () => {
    const insight = await inA((db) =>
      db.insight.findFirst({ where: { id: fixtures.b.insightId } }),
    );
    expect(insight).toBeNull();

    const evidence = await inA((db) =>
      db.insightEvidence.findMany({ where: { insightId: fixtures.b.insightId } }),
    );
    expect(evidence).toHaveLength(0);
  });

  it('listing insights returns only this workspace, and only in-scope brands', async () => {
    const rows = await inA((db) =>
      insights(db).list({
        brandScope: [fixtures.a.brandId],
        take: 50,
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(rows.every((row) => row.brandId === fixtures.a.brandId)).toBe(true);
  });
});

describe('a fabricated citation cannot become an insight', () => {
  async function explainWith(output: string) {
    nextOutput = output;
    return inA((db) =>
      insights(db).explain({
        brandId: fixtures.a.brandId,
        scope: { brandId: fixtures.a.brandId },
        period: PERIOD,
        idempotencyKey: `fabricated-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [fixtures.a.brandId],
        expiresAt: null,
      }),
    );
  }

  it('a citation to a row that does not exist is REFUSED, and nothing is persisted', async () => {
    const before = await inA((db) => db.insight.count({}));
    await expect(explainWith(fabricatedCitationResponse())).rejects.toThrow();
    // NOT A DEGRADED INSIGHT, NOT A WARNING BANNER. No row at all: prose whose
    // citation points at nothing is not something this product shows a customer.
    expect(await inA((db) => db.insight.count({}))).toBe(before);
  });

  it('a correctly-cited claim containing an UNMEASURED figure is refused too', async () => {
    /*
     * THE MORE DANGEROUS ONE. The citation makes the sentence look checked, and
     * the number in it was never measured by anybody.
     */
    const before = await inA((db) => db.insight.count({}));
    await expect(explainWith(fabricatedNumberResponse())).rejects.toThrow();
    expect(await inA((db) => db.insight.count({}))).toBe(before);
  });

  it('a refused generation leaves no reservation open — the refusal is free of residue', () => {
    /*
     * A FAILED REQUEST NEVER STRANDS CREDITS. The gateway's reserve → execute →
     * settle protocol releases on every exit path, and a grounding refusal is
     * just another exit path.
     */
    return openReservations().then((open) => expect(open).toBe(baselineOpenReservations));
  });
});
