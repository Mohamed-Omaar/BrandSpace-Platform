import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AiGateway,
  MockProviderAdapter,
  type AiConfiguration,
  type AiProviderAdapter,
} from '@brandspace/ai-gateway';
import { defaultPayload } from '@brandspace/config';
import { parseAutomationPolicy } from '@brandspace/automation';
import { parseContentPolicy } from '@brandspace/content';
import {
  AUTOMATION_AI_ACTIONS_FEATURE,
  CreditLedgerService,
  workspaceMonthLabel,
  type CreditPolicy,
} from '@brandspace/entitlements';
import type { Clock } from '@brandspace/shared';
import {
  AutomationAiExecutor,
  ideasRouteKeepsOutput,
} from '../../apps/api/src/automation-ai-executor';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2B-3 PR 6 — THE AI EXECUTOR, AGAINST REAL POSTGRESQL AND THE REAL
 * GATEWAY, WITH THE MOCK PROVIDER.
 *
 *   - the happy path: three DRAFT ideas, one charge, one cap slot;
 *   - every refusal before the call charges nothing and counts nothing;
 *   - not enough credits, a provider that keeps failing, persistOutput off:
 *     nothing charged, the slot given back;
 *   - an unusable answer: charged once, the slot kept, nothing saved;
 *   - a crash after the charge: the retry replays the stored answer — one
 *     charge, three ideas, never six;
 *   - two executors racing: one wins;
 *   - only approved, current facts reach the AI;
 *   - another workspace's run cannot be claimed.
 *
 * The cap comes from a WORKSPACE OVERRIDE on this file's own fixture
 * workspace, never from a shared plan snapshot; the clock is frozen at load.
 */

const CREDIT_POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

const MODEL = 'mock-fast';
const TASK = 'ideas.generate';

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let ledger: CreditLedgerService;
let gateway: AiGateway;
let adapter: CapturingAdapter;
let executor: AutomationAiExecutor;

let nowMs = Math.floor(Date.now() / 1000) * 1000;
const clock: Clock = { now: () => new Date(nowMs) };

const policy = parseAutomationPolicy(defaultPayload('automations'));
const contentPolicy = parseContentPolicy(defaultPayload('content'));

/** The mock, with every request it was sent recorded and its text replaceable. */
class CapturingAdapter implements AiProviderAdapter {
  readonly key = 'mock';
  readonly supportedModalities = ['text'] as const;
  readonly requests: { prompt: string; untrustedContext: readonly string[] }[] = [];
  nextText: string | null = null;
  constructor(readonly inner: MockProviderAdapter) {}
  testConnection(ctx: Parameters<AiProviderAdapter['testConnection']>[0]) {
    return this.inner.testConnection(ctx);
  }
  async generateText(
    request: Parameters<NonNullable<AiProviderAdapter['generateText']>>[0],
    ctx: Parameters<NonNullable<AiProviderAdapter['generateText']>>[1],
  ) {
    this.requests.push({
      prompt: request.prompt,
      untrustedContext: request.untrustedContext ?? [],
    });
    const result = await this.inner.generateText(request, ctx);
    if (this.nextText !== null) {
      const text = this.nextText;
      this.nextText = null;
      return { ...result, text };
    }
    return result;
  }
  classifyError(error: unknown) {
    return this.inner.classifyError(error);
  }
}

function configuration(
  overrides: { persistOutput?: boolean; baseMilliCredits?: number } = {},
): AiConfiguration {
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
        key: MODEL,
        providerKey: 'mock',
        modality: 'text',
        qualityTier: 'fast',
        status: 'available',
        disableSwitch: false,
      },
    ],
    costBases: [],
    routingRules: [
      {
        taskKey: TASK,
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: MODEL,
        fallbackModelKeys: [],
        timeoutMs: 5_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.7,
          maxOutputTokens: 200,
          promptTemplateVersion: 1,
          persistOutput: overrides.persistOutput ?? true,
          outputRetentionDays: 7,
        },
        retryPolicy: { maxAttempts: 1, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
    ],
    creditRules: [
      {
        taskKey: TASK,
        modelKey: MODEL,
        baseMilliCredits: overrides.baseMilliCredits ?? 100,
        perUnitMilliCredits: 0,
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
  } as AiConfiguration;
}

let active: AiConfiguration = configuration();

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  ledger = new CreditLedgerService({ prisma: platform, policy: CREDIT_POLICY });
  await ledger.grant({
    workspaceId: fixtures.a.workspaceId,
    source: 'PLAN_GRANT',
    credits: 50,
    reason: 'PR 6 executor fixture allowance',
    idempotencyKey: `pr6-exec-grant-${fixtures.a.workspaceId}`,
  });
  adapter = new CapturingAdapter(new MockProviderAdapter());
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters: new Map<string, AiProviderAdapter>([['mock', adapter]]),
    configuration: { load: async () => active },
    credentials: { resolve: async () => null },
    environment: 'DEVELOPMENT',
    random: () => 0.5,
  });
  executor = new AutomationAiExecutor({
    environment: 'DEVELOPMENT',
    clock,
    platform,
    app,
    gateway,
    automationPolicy: async () => policy,
    contentPolicy: async () => contentPolicy,
    routingRules: async () => active.routingRules,
  });
  // THE CAP, for this workspace only.
  await platform.workspaceOverride.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      featureKey: AUTOMATION_AI_ACTIONS_FEATURE,
      enabled: true,
      limitValue: 1000,
      reason: 'PR 6 executor fixture cap',
      grantedByPlatformUserId: fixtures.platformUserId,
    },
  });
}, 90_000);

afterAll(async () => {
  await platform.aiRequest.deleteMany({
    where: {
      workspaceId: { in: [fixtures.a.workspaceId, fixtures.b.workspaceId] },
      status: { in: ['PENDING', 'RESERVED', 'RUNNING'] },
    },
  });
  await app.$disconnect();
  await platform.$disconnect();
});

beforeEach(() => {
  active = configuration();
  adapter.requests.length = 0;
  adapter.nextText = null;
  adapter.inner.reset();
});

async function setCap(limitValue: number, enabled = true): Promise<void> {
  await platform.workspaceOverride.updateMany({
    where: { workspaceId: fixtures.a.workspaceId, featureKey: AUTOMATION_AI_ACTIONS_FEATURE },
    data: { limitValue, enabled },
  });
}

async function used(): Promise<number> {
  const row = await platform.usageCounter.findFirst({
    where: {
      workspaceId: fixtures.a.workspaceId,
      featureKey: AUTOMATION_AI_ACTIONS_FEATURE,
      periodStart: new Date(`${workspaceMonthLabel('UTC', clock.now())}-01T00:00:00.000Z`),
    },
    select: { usedValue: true },
  });
  return row?.usedValue ?? 0;
}

async function balance(): Promise<bigint> {
  const wallet = await platform.creditWallet.findUniqueOrThrow({
    where: { workspaceId: fixtures.a.workspaceId },
  });
  return wallet.balanceMilliCredits;
}

/** A DRAFT_IDEAS rule and one run waiting for the executor, due now. */
async function waitingRun(
  overrides: {
    brandId?: string;
    createdByUserId?: string;
    enabled?: boolean;
    attempts?: number;
    status?: 'AWAITING_EXECUTION' | 'EXECUTING';
  } = {},
): Promise<string> {
  const brandId = overrides.brandId ?? fixtures.a.brandId;
  const rule = await platform.automationRule.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId,
      name: `pr6 exec ${randomUUID().slice(0, 8)}`,
      enabled: overrides.enabled ?? true,
      triggerType: 'POST_TOP_10_PERCENT',
      triggerConfig: {},
      conditions: [],
      actionType: 'DRAFT_IDEAS',
      actionConfig: {},
      createdByUserId: overrides.createdByUserId ?? fixtures.a.userId,
    },
    select: { id: true },
  });
  const status = overrides.status ?? 'AWAITING_EXECUTION';
  const run = await platform.automationRun.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId,
      ruleId: rule.id,
      status,
      triggerType: 'POST_TOP_10_PERCENT',
      triggerRefType: 'ContentItem',
      triggerRefId: fixtures.a.contentItemId,
      idempotencyKey: `pr6-exec-${randomUUID()}`,
      conditionsHeld: true,
      actionType: 'DRAFT_IDEAS',
      correlationId: randomUUID(),
      executionAvailableAt: new Date(nowMs - 1_000),
      executionAttempts: overrides.attempts ?? 0,
      executionLeaseId: status === 'EXECUTING' ? randomUUID() : null,
    },
    select: { id: true },
  });
  return run.id;
}

const runRow = (id: string) => platform.automationRun.findUniqueOrThrow({ where: { id } });
const ideasOf = (runId: string) =>
  platform.contentItem.findMany({
    where: { idempotencyKey: { startsWith: `automation-ideas:${runId}:` } },
    orderBy: { idempotencyKey: 'asc' },
  });
const requestsFor = (runId: string) =>
  platform.aiRequest.findMany({
    where: { idempotencyKey: { startsWith: `automation-run:${runId}` } },
  });

describe('the happy path', () => {
  it('three DRAFT ideas, titles only, one charge, one cap slot', async () => {
    const id = await waitingRun();
    const before = { balance: await balance(), used: await used() };

    const outcome = await executor.executeRun(id, fixtures.a.workspaceId);
    expect(outcome).toEqual({ kind: 'finished', status: 'SUCCEEDED', code: null });

    const ideas = await ideasOf(id);
    expect(ideas.map((idea) => idea.title)).toEqual([
      'A first sample idea for this brand',
      'A second sample idea for this brand',
      'A third sample idea for this brand',
    ]);
    for (const idea of ideas) {
      expect(idea).toMatchObject({
        status: 'DRAFT',
        origin: 'AI_GENERATED',
        createdByUserId: fixtures.a.userId,
        brandId: fixtures.a.brandId,
        primaryLocale: 'EN',
      });
      expect(idea.aiRequestId).not.toBeNull();
      expect(JSON.stringify(idea.citations)).toContain(fixtures.a.knowledgeItemId);
    }
    // IDEAS ONLY: no variant, no slot, no approval, no publish job.
    const ids = ideas.map((idea) => idea.id);
    expect(await platform.contentVariant.count({ where: { contentItemId: { in: ids } } })).toBe(0);
    expect(await platform.calendarSlot.count({ where: { contentItemId: { in: ids } } })).toBe(0);
    expect(await platform.approval.count({ where: { contentItemId: { in: ids } } })).toBe(0);
    expect(await platform.publishJob.count({ where: { contentItemId: { in: ids } } })).toBe(0);

    const run = await runRow(id);
    expect(run).toMatchObject({
      status: 'SUCCEEDED',
      failureCode: null,
      executionLeaseId: null,
      executionAvailableAt: null,
      executionAttempts: 1,
      resourceType: 'ContentItem',
      resourceId: ids[0],
    });
    expect(run.actionResult).toMatchObject({
      capPeriod: workspaceMonthLabel('UTC', clock.now()),
      ideaItemIds: ids,
    });

    const requests = await requestsFor(id);
    expect(requests.map((request) => request.status)).toEqual(['SUCCEEDED']);
    expect(before.balance - (await balance())).toBe(requests[0]!.creditsChargedMilli);
    expect(await used()).toBe(before.used + 1);
    expect(
      await platform.auditEvent.count({
        where: { action: 'content.item.generated', resourceId: { in: ids } },
      }),
    ).toBe(3);
  });

  it('the instruction carries no customer text; the event and the facts are fenced data', async () => {
    const id = await waitingRun();
    await executor.executeRun(id, fixtures.a.workspaceId);
    const sent = adapter.requests.at(-1)!;
    const topPost = await platform.contentItem.findUniqueOrThrow({
      where: { id: fixtures.a.contentItemId },
    });
    expect(sent.prompt).not.toContain(topPost.title);
    expect(sent.prompt).toContain("A recent post performed in the brand's top tenth.");
    const context = sent.untrustedContext.join('\n');
    expect(context).toContain(`Top post: ${topPost.title}`);
    expect(context).toContain(`${fixtures.a.slug} positioning statement`);
  });

  it('another workspace cannot claim, read or finish the run', async () => {
    const id = await waitingRun();
    expect(await executor.executeRun(id, fixtures.b.workspaceId)).toEqual({ kind: 'not_claimed' });
    expect((await runRow(id)).status).toBe('AWAITING_EXECUTION');
    expect(adapter.requests).toHaveLength(0);
  });
});

describe('every refusal before the call charges nothing and counts nothing', () => {
  async function refused(id: string, status: string, code: string) {
    const before = { balance: await balance(), used: await used() };
    const outcome = await executor.executeRun(id, fixtures.a.workspaceId);
    expect(outcome).toEqual({ kind: 'finished', status, code });
    expect(adapter.requests).toHaveLength(0);
    expect(await requestsFor(id)).toEqual([]);
    expect(await balance()).toBe(before.balance);
    expect(await used()).toBe(before.used);
    expect(await ideasOf(id)).toEqual([]);
    expect(await runRow(id)).toMatchObject({ status, failureCode: code, executionLeaseId: null });
  }

  it('the rule was switched off: rule_disabled', async () => {
    await refused(await waitingRun({ enabled: false }), 'BLOCKED_BY_POLICY', 'rule_disabled');
  });

  it('the creator is not a member: creator_no_longer_a_member', async () => {
    await refused(
      await waitingRun({ createdByUserId: fixtures.b.userId }),
      'BLOCKED_BY_AUTHORIZATION',
      'creator_no_longer_a_member',
    );
  });

  it('the plan no longer includes it: not_entitled', async () => {
    await setCap(1000, false);
    try {
      await refused(await waitingRun(), 'BLOCKED_BY_POLICY', 'not_entitled');
    } finally {
      await setCap(1000);
    }
  });

  it('an archived brand: brand_not_active', async () => {
    const archived = await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `pr6-archived-${randomUUID().slice(0, 8)}`,
        name: 'PR 6 archived',
        status: 'ARCHIVED',
      },
      select: { id: true },
    });
    await refused(await waitingRun({ brandId: archived.id }), 'SKIPPED', 'brand_not_active');
  });

  it('Brand Brain off for writing: no_reviewed_facts', async () => {
    await platform.brand.update({
      where: { id: fixtures.a.brandId },
      data: { useBrandBrain: false },
    });
    try {
      await refused(await waitingRun(), 'SKIPPED', 'no_reviewed_facts');
    } finally {
      await platform.brand.update({
        where: { id: fixtures.a.brandId },
        data: { useBrandBrain: true },
      });
    }
  });

  it('a brand with no usable facts: no_reviewed_facts', async () => {
    const empty = await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `pr6-empty-${randomUUID().slice(0, 8)}`,
        name: 'PR 6 no facts',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    await refused(await waitingRun({ brandId: empty.id }), 'SKIPPED', 'no_reviewed_facts');
  });

  it('a routing rule that does not keep the output: ai_unavailable, never started', async () => {
    active = configuration({ persistOutput: false });
    await refused(await waitingRun(), 'FAILED', 'ai_unavailable');
  });

  it('the monthly cap is reached: monthly_ai_cap_reached', async () => {
    await setCap(await used());
    try {
      await refused(await waitingRun(), 'SKIPPED', 'monthly_ai_cap_reached');
    } finally {
      await setCap(1000);
    }
  });
});

describe('the gateway refuses or fails: nothing charged, the slot given back', () => {
  it('not enough credits: SKIPPED ai_credits_insufficient', async () => {
    active = configuration({ baseMilliCredits: 100_000_000 });
    const id = await waitingRun();
    const before = { balance: await balance(), used: await used() };
    expect(await executor.executeRun(id, fixtures.a.workspaceId)).toEqual({
      kind: 'finished',
      status: 'SKIPPED',
      code: 'ai_credits_insufficient',
    });
    expect(await balance()).toBe(before.balance);
    expect(await used()).toBe(before.used);
    expect(await ideasOf(id)).toEqual([]);
  });

  it('a provider that keeps failing: retried, then FAILED ai_unavailable', async () => {
    adapter.inner.program({ failWith: 'PROVIDER_UNAVAILABLE', times: 10 });
    const id = await waitingRun();
    const before = { balance: await balance(), used: await used() };

    expect(await executor.executeRun(id, fixtures.a.workspaceId)).toEqual({ kind: 'retry_later' });
    const waiting = await runRow(id);
    expect(waiting).toMatchObject({
      status: 'AWAITING_EXECUTION',
      executionAttempts: 1,
      executionLeaseId: null,
    });
    // The slot is held while it waits.
    expect(await used()).toBe(before.used + 1);
    // Not due yet: the backoff is one lease per attempt.
    expect(await executor.executeRun(id, fixtures.a.workspaceId)).toEqual({ kind: 'not_claimed' });

    for (let attempt = 2; attempt <= policy.execution.aiMaxAttempts; attempt += 1) {
      nowMs += policy.execution.claimLeaseSeconds * 1_000 * attempt;
      const outcome = await executor.executeRun(id, fixtures.a.workspaceId);
      if (attempt < policy.execution.aiMaxAttempts)
        expect(outcome).toEqual({ kind: 'retry_later' });
      else expect(outcome).toEqual({ kind: 'finished', status: 'FAILED', code: 'ai_unavailable' });
    }
    expect(await runRow(id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'ai_unavailable',
      executionAttempts: policy.execution.aiMaxAttempts,
    });
    expect(await balance()).toBe(before.balance);
    expect(await used()).toBe(before.used);
    expect(await ideasOf(id)).toEqual([]);
  });
});

describe('the AI answered', () => {
  it('an unusable answer: FAILED ai_output_unusable, charged once, the slot kept', async () => {
    adapter.nextText = 'Here are some ideas: post more.';
    const id = await waitingRun();
    const before = { balance: await balance(), used: await used() };
    expect(await executor.executeRun(id, fixtures.a.workspaceId)).toEqual({
      kind: 'finished',
      status: 'FAILED',
      code: 'ai_output_unusable',
    });
    const requests = await requestsFor(id);
    expect(requests.map((request) => request.status)).toEqual(['SUCCEEDED']);
    expect(before.balance - (await balance())).toBe(requests[0]!.creditsChargedMilli);
    expect(requests[0]!.creditsChargedMilli).toBeGreaterThan(0n);
    expect(await used()).toBe(before.used + 1);
    expect(await ideasOf(id)).toEqual([]);
  });

  it('a crash after the charge: the retry replays the answer — one charge, three ideas', async () => {
    const id = await waitingRun();
    // Attempt 1 claimed the run and was charged, then died before saving.
    expect(await executor.executeRun(id, fixtures.a.workspaceId)).toMatchObject({
      kind: 'finished',
    });
    // Rewind to "attempt 1 died after the gateway call": no ideas, run held
    // under an expired lease. The gateway's row and the charge stay.
    await platform.contentItem.deleteMany({
      where: { idempotencyKey: { startsWith: `automation-ideas:${id}:` } },
    });
    await platform.automationRun.update({
      where: { id },
      data: {
        status: 'EXECUTING',
        executionLeaseId: randomUUID(),
        executionAvailableAt: new Date(nowMs - 1_000),
        finishedAt: null,
        failureCode: null,
      },
    });
    const before = { balance: await balance(), used: await used(), calls: adapter.requests.length };

    expect(await executor.executeRun(id, fixtures.a.workspaceId)).toEqual({
      kind: 'finished',
      status: 'SUCCEEDED',
      code: null,
    });
    expect(await ideasOf(id)).toHaveLength(3);
    // Replayed: no provider call, no charge, no second slot.
    expect(adapter.requests.length).toBe(before.calls);
    expect(await balance()).toBe(before.balance);
    expect(await used()).toBe(before.used);
    expect((await requestsFor(id)).map((request) => request.status)).toEqual(['SUCCEEDED']);
  });

  it('two executors racing for one run: one wins, three ideas, one charge', async () => {
    const id = await waitingRun();
    const outcomes = await Promise.all([
      executor.executeRun(id, fixtures.a.workspaceId),
      executor.executeRun(id, fixtures.a.workspaceId),
    ]);
    expect(outcomes.filter((outcome) => outcome.kind === 'finished')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'not_claimed')).toHaveLength(1);
    expect(await ideasOf(id)).toHaveLength(3);
    expect((await requestsFor(id)).map((request) => request.status)).toEqual(['SUCCEEDED']);
  });
});

describe('a run that used every attempt', () => {
  it('is given up by the sweep: FAILED ai_unavailable, nothing charged', async () => {
    const id = await waitingRun({ status: 'EXECUTING', attempts: policy.execution.aiMaxAttempts });
    const swept = await executor.sweep();
    expect(swept.abandoned).toBeGreaterThanOrEqual(1);
    expect(await runRow(id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'ai_unavailable',
      executionLeaseId: null,
    });
    expect(await requestsFor(id)).toEqual([]);
  });
});

describe('only approved, current facts reach the AI', () => {
  it('never a draft, proposed, archived or expired fact, a candidate, a raw chunk or another workspace', async () => {
    const brand = await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `pr6-facts-${randomUUID().slice(0, 8)}`,
        name: 'PR 6 facts',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const yesterday = new Date(nowMs - 2 * 86_400_000);
    const fact = (
      key: string,
      status: 'DRAFT' | 'PROPOSED' | 'ACTIVE' | 'STALE' | 'ARCHIVED',
      marker: string,
      validUntil: Date | null = null,
    ) =>
      platform.brandKnowledgeItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: brand.id,
          area: 'OFFERS',
          memory: 'CANONICAL',
          origin: 'HUMAN',
          status,
          itemKey: key,
          title: { en: marker },
          body: { en: `${marker} body` },
          createdByUserId: fixtures.a.userId,
          version: 1,
          validUntil,
        },
      });
    await fact('pr6.active', 'ACTIVE', 'MARKER_ACTIVE_OK');
    await fact('pr6.stale', 'STALE', 'MARKER_STALE_OK');
    await fact('pr6.draft', 'DRAFT', 'MARKER_DRAFT');
    await fact('pr6.proposed', 'PROPOSED', 'MARKER_PROPOSED');
    await fact('pr6.archived', 'ARCHIVED', 'MARKER_ARCHIVED');
    await fact('pr6.expired', 'ACTIVE', 'MARKER_EXPIRED', yesterday);

    const id = await waitingRun({ brandId: brand.id });
    expect(await executor.executeRun(id, fixtures.a.workspaceId)).toMatchObject({
      status: 'SUCCEEDED',
    });
    const context = adapter.requests.at(-1)!.untrustedContext.join('\n');
    expect(context).toContain('MARKER_ACTIVE_OK');
    expect(context).toContain('MARKER_STALE_OK');
    for (const forbidden of [
      'MARKER_DRAFT',
      'MARKER_PROPOSED',
      'MARKER_ARCHIVED',
      'MARKER_EXPIRED',
      // The fixture's raw source chunk, and both workspaces' other brand facts.
      'Confidential positioning',
      `${fixtures.a.slug} positioning statement`,
      `${fixtures.b.slug} positioning statement`,
    ]) {
      expect(context, forbidden).not.toContain(forbidden);
    }
  });
});

describe('the persistOutput pre-check', () => {
  const rule = (overrides: Partial<Parameters<typeof ideasRouteKeepsOutput>[0][number]>) => ({
    taskKey: TASK,
    scope: 'global',
    planKey: null,
    workspaceId: null,
    parameters: { persistOutput: true },
    ...overrides,
  });
  const target = { planKey: 'p', workspaceId: 'w' };

  it('every applicable rule must keep the output, and there must be one', () => {
    expect(ideasRouteKeepsOutput([], target)).toBe(false);
    expect(ideasRouteKeepsOutput([rule({})], target)).toBe(true);
    expect(ideasRouteKeepsOutput([rule({ parameters: { persistOutput: false } })], target)).toBe(
      false,
    );
    expect(
      ideasRouteKeepsOutput(
        [rule({}), rule({ scope: 'plan', planKey: 'p', parameters: { persistOutput: false } })],
        target,
      ),
    ).toBe(false);
    // A rule for another plan, workspace or task does not apply.
    expect(
      ideasRouteKeepsOutput(
        [
          rule({}),
          rule({ scope: 'plan', planKey: 'q', parameters: {} }),
          rule({ scope: 'workspace', workspaceId: 'x', parameters: {} }),
          rule({ taskKey: 'caption.generate', parameters: {} }),
        ],
        target,
      ),
    ).toBe(true);
  });
});
