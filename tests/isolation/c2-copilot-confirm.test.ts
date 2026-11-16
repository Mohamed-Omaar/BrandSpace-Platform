import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AiGateway,
  type AiConfiguration,
  type AiFailureClass,
  type AiProviderAdapter,
  type TextResult,
} from '@brandspace/ai-gateway';
import { defaultPayload } from '@brandspace/config';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  CampaignService,
  ContentStudioService,
  type ContentPolicy,
  type StudioRun,
} from '@brandspace/content';
import {
  CopilotPlanService,
  contentDraftInput,
  parseCopilotPolicy,
  pruneCopilot,
  resolveLiveAuthorization,
  runConfirmedPlan,
  type ExecutorContext,
  type LiveAuthorization,
} from '@brandspace/copilot';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * C2 (F-112, owner 2026-11-14) — A CONFIRMED COPILOT PLAN NEVER HOLDS A
 * TRANSACTION ACROSS A MODEL CALL.
 *
 * `/v1/copilot/confirm` ran the whole plan in one tenant transaction and its
 * `content.draft` step called the provider inside it. Here every tenant
 * transaction may live ONE second and the model takes ONE AND A HALF: the old
 * shape expires (shown below), the new one (`runConfirmedPlan`, what the route
 * runs) confirms, drafts and charges once. Against real PostgreSQL, with the
 * real gateway and credit ledger and a scripted provider.
 */

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};
const MODEL_KEY = 'mock-fast';
const TASK_KEY = 'caption.generate';
const TRANSACTION_MS = 1_000;
const SLOW_MODEL_MS = 1_500;

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
      maxMediaItems: 10,
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
  learning: {
    preferenceMinObservations: 4,
    preferenceMinPosts: 3,
    workflowMinRepeats: 4,
    windowDays: 90,
    snoozeDays: 30,
  },
  approvals: {
    requireApprovalBeforeScheduling: false,
    allowSelfApproval: false,
    clientApprovalEnabled: false,
    maxNoteLength: 1_000,
    maxCyclesPerItem: 25,
  },
};

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
        timeoutMs: 10_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.4,
          maxOutputTokens: 256,
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

type Scripted = { readonly fail: true } | { readonly text: string; readonly delayMs: number };
const script: Scripted[] = [];

class ScriptedProviderError extends Error {}

/** A provider that answers what the test scripted, as slowly as it says. */
class ScriptedTextAdapter implements AiProviderAdapter {
  readonly key = 'mock';
  readonly supportedModalities = ['text'] as const;
  calls = 0;

  async testConnection() {
    return { ok: true, latencyMs: 0, message: 'scripted' };
  }

  async generateText(request: { modelKey: string; prompt: string }): Promise<TextResult> {
    this.calls += 1;
    const next = script.shift() ?? { text: reply(), delayMs: 0 };
    if ('fail' in next) throw new ScriptedProviderError('scripted outage');
    await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    return {
      text: next.text,
      usage: { promptTokens: Math.ceil(request.prompt.length / 4), completionTokens: 40 },
      modelKey: request.modelKey,
    };
  }

  classifyError(error: unknown): AiFailureClass {
    return error instanceof ScriptedProviderError ? 'PROVIDER_UNAVAILABLE' : 'UNKNOWN';
  }
}

function reply(): string {
  return JSON.stringify({
    title: 'Cardamom cold brew',
    variants: [{ platformKey: 'instagram', body: 'Cardamom cold brew is here.', hashtags: [] }],
  });
}

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let ledger: CreditLedgerService;
let gateway: AiGateway;
let adapter: ScriptedTextAdapter;
let authorization: LiveAuthorization;
let sessionId: string;

const copilotPolicy = () => parseCopilotPolicy(defaultPayload('copilot'));

/** A tenant transaction that may live at most one second. */
function shortly<T>(fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app, timeoutMs: TRANSACTION_MS });
}

function plansIn(db: TenantScopedClient): CopilotPlanService {
  return new CopilotPlanService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: copilotPolicy(),
  });
}

/** The few collaborators a `content.draft` step reaches once it has a draft. */
function contextIn(db: TenantScopedClient) {
  return (live: LiveAuthorization) =>
    ({
      db,
      workspaceId: fixtures.a.workspaceId,
      authorization: live,
      campaigns: new CampaignService({ db, workspaceId: fixtures.a.workspaceId }),
    }) as unknown as ExecutorContext;
}

const studioRun: StudioRun = (fn) =>
  shortly(async (db) =>
    fn(
      new ContentStudioService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: CONTENT_POLICY,
        gateway,
      }),
    ),
  );

async function confirmablePlan() {
  return withWorkspace(
    fixtures.a.workspaceId,
    (db) =>
      plansIn(db).createPlan({
        sessionId,
        brandId: fixtures.a.brandId,
        authorization,
        steps: [
          {
            toolKey: 'content.draft',
            arguments: {
              brandId: fixtures.a.brandId,
              title: 'Cardamom cold brew',
              brief: `Announce the cardamom cold brew ${randomUUID()}`,
              platformKeys: ['instagram'],
              locale: 'EN',
            },
          },
        ],
        summary: { ar: 'مسودة', en: 'A draft' },
        estimatedCreditsMilli: 0n,
        expiresAt: null,
      }),
    { prisma: app },
  );
}

function confirmAndRun(created: Awaited<ReturnType<typeof confirmablePlan>>) {
  return runConfirmedPlan({
    planId: created.plan.id,
    planHash: created.plan.planHash,
    token: created.confirmationToken!,
    userId: fixtures.a.userId,
    run: shortly,
    services: async (db) => ({ plans: plansIn(db), context: contextIn(db) }),
    generating: new Set(['content.draft']),
    generate: (paused, state) =>
      ContentStudioService.generateWith(
        studioRun,
        contentDraftInput(
          {
            authorization: state.authorization,
            planKey: null,
            retention: { subscriptionActive: true },
          },
          paused.step.arguments,
          paused.idempotencyKey,
        ),
      ),
  });
}

const wallet = () =>
  platform.creditWallet.findUniqueOrThrow({ where: { workspaceId: fixtures.a.workspaceId } });
const drafts = () => platform.contentItem.count({ where: { workspaceId: fixtures.a.workspaceId } });

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
  adapter = new ScriptedTextAdapter();
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters: new Map<string, AiProviderAdapter>([['mock', adapter]]),
    configuration: { load: async () => configuration() },
    credentials: { resolve: async () => null },
    environment: 'DEVELOPMENT',
  });
  await platform.creditWallet.upsert({
    where: { workspaceId: fixtures.a.workspaceId },
    create: { workspaceId: fixtures.a.workspaceId },
    update: {},
  });
  await ledger.grant({
    workspaceId: fixtures.a.workspaceId,
    source: 'PLAN_GRANT',
    credits: 500,
    reason: 'C2 fixture allowance',
    idempotencyKey: `c2-grant-${fixtures.a.workspaceId}`,
  });
  // The studio grounds on Brand Brain: give the fixture brand's knowledge
  // the words the briefs ask about, so a draft is generated, not refused.
  await withWorkspace(
    fixtures.a.workspaceId,
    (db) =>
      db.brandKnowledgeItem.updateMany({
        where: { brandId: fixtures.a.brandId },
        data: {
          body: {
            en: 'Announce the cardamom cold brew: our new cardamom cold brew is brewed for twenty hours.',
            ar: 'أعلن عن القهوة الباردة بالهيل: قهوتنا الباردة الجديدة بالهيل تُخمّر عشرين ساعة.',
          },
        },
      }),
    { prisma: app },
  );
  authorization = (await withWorkspace(
    fixtures.a.workspaceId,
    (db) => resolveLiveAuthorization(db, fixtures.a.workspaceId, fixtures.a.userId),
    { prisma: app },
  ))!;
  // One conversation per person per brand (D-594): this person's, or a new one.
  sessionId = await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const where = {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        userId: fixtures.a.userId,
      };
      const existing = await db.copilotSession.findFirst({ where, select: { id: true } });
      return (existing ?? (await db.copilotSession.create({ data: where, select: { id: true } })))
        .id;
    },
    { prisma: app },
  );
}, 120_000);

beforeEach(() => {
  script.length = 0;
});

afterAll(async () => {
  await platform?.creditReservation.deleteMany({ where: { workspaceId: fixtures.a.workspaceId } });
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('C2 · the model runs with no transaction open', () => {
  it('the old shape — the whole plan in one transaction — expires under a slow model', async () => {
    const created = await confirmablePlan();
    script.push({ text: reply(), delayMs: SLOW_MODEL_MS });
    await expect(
      shortly(async (db) => {
        const plans = plansIn(db);
        await plans.confirm({
          planId: created.plan.id,
          planHash: created.plan.planHash,
          token: created.confirmationToken!,
          userId: fixtures.a.userId,
        });
        return plans.execute({
          planId: created.plan.id,
          userId: fixtures.a.userId,
          context: (live) => ({
            ...contextIn(db)(live),
            studio: new ContentStudioService({
              db,
              workspaceId: fixtures.a.workspaceId,
              policy: CONTENT_POLICY,
              gateway,
            }),
            planKey: null,
            retention: { subscriptionActive: true },
          }),
        });
      }),
    ).rejects.toThrow();
  });

  it('confirmed in short transactions: a model slower than any of them still drafts, charged once', async () => {
    const before = await wallet();
    const draftsBefore = await drafts();
    const created = await confirmablePlan();
    script.push({ text: reply(), delayMs: SLOW_MODEL_MS });

    const outcome = await confirmAndRun(created);

    expect(outcome.plan.status).toBe('COMPLETED');
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]).toMatchObject({
      status: 'SUCCEEDED',
      toolKey: 'content.draft',
      resourceType: 'ContentItem',
    });
    expect(outcome.creditsChargedMilli).toBeGreaterThan(0n);
    expect(outcome.plan.undoStatus).toBe('AVAILABLE');
    expect(await drafts()).toBe(draftsBefore + 1);
    const after = await wallet();
    expect(before.balanceMilliCredits - after.balanceMilliCredits).toBe(
      outcome.creditsChargedMilli,
    );
    expect(after.reservedMilliCredits).toBe(before.reservedMilliCredits);
  });

  it('a model that fails: the plan FAILS, no draft, nothing charged', async () => {
    const before = await wallet();
    const draftsBefore = await drafts();
    const created = await confirmablePlan();
    script.push({ fail: true });

    const outcome = await confirmAndRun(created);

    expect(outcome.plan.status).toBe('FAILED');
    expect(outcome.toolCalls[0]).toMatchObject({ status: 'FAILED', toolKey: 'content.draft' });
    expect(outcome.toolCalls[0]?.failureCode).toBeTruthy();
    expect(outcome.creditsChargedMilli).toBe(0n);
    expect(await drafts()).toBe(draftsBefore);
    const after = await wallet();
    expect(after.balanceMilliCredits).toBe(before.balanceMilliCredits);
    expect(after.reservedMilliCredits).toBe(before.reservedMilliCredits);
  });

  it('a second press of Confirm runs nothing again: no second draft, no second charge', async () => {
    const created = await confirmablePlan();
    script.push({ text: reply(), delayMs: 0 });
    await confirmAndRun(created);
    const afterFirst = await wallet();
    const draftsAfterFirst = await drafts();
    const callsAfterFirst = adapter.calls;

    await expect(confirmAndRun(created)).rejects.toThrow();
    expect(await drafts()).toBe(draftsAfterFirst);
    expect((await wallet()).balanceMilliCredits).toBe(afterFirst.balanceMilliCredits);
    expect(adapter.calls).toBe(callsAfterFirst);
  });
});

describe('C2 · a plan left running by a stopped process ends FAILED', () => {
  it('the sweep turns an EXECUTING plan older than ten minutes into FAILED "interrupted"', async () => {
    const created = await confirmablePlan();
    const plan = created.plan;
    // As a process that stopped between two short transactions leaves it.
    await platform.copilotActionPlan.update({
      where: { id: plan.id },
      data: {
        status: 'EXECUTING',
        confirmedAt: new Date(),
        confirmedByUserId: fixtures.a.userId,
        startedAt: new Date(Date.now() - 11 * 60_000),
      },
    });
    await platform.copilotToolCall.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        planId: plan.id,
        sessionId,
        ordinal: 1,
        toolKey: 'content.draft',
        actionClass: 'INTERNAL_REVERSIBLE',
        status: 'RUNNING',
        argumentsJson: {},
        idempotencyKey: `c2-interrupted-${randomUUID()}`,
      },
    });
    // A plan EXECUTING for one minute is still running, and left alone.
    const recent = await confirmablePlan();
    await platform.copilotActionPlan.update({
      where: { id: recent.plan.id },
      data: {
        status: 'EXECUTING',
        confirmedAt: new Date(),
        confirmedByUserId: fixtures.a.userId,
        startedAt: new Date(Date.now() - 60_000),
      },
    });

    const result = await pruneCopilot({
      prisma: platform,
      policy: copilotPolicy(),
      clock: { now: () => new Date() },
    });

    expect(result.plansInterrupted).toBeGreaterThanOrEqual(1);
    const ended = await platform.copilotActionPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(ended).toMatchObject({ status: 'FAILED', failureCode: 'interrupted' });
    const call = await platform.copilotToolCall.findFirstOrThrow({ where: { planId: plan.id } });
    expect(call).toMatchObject({ status: 'FAILED', failureCode: 'interrupted' });
    const running = await platform.copilotActionPlan.findUniqueOrThrow({
      where: { id: recent.plan.id },
    });
    expect(running.status).toBe('EXECUTING');
  });
});
