import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  AiGateway,
  type AdapterContext,
  type AiConfiguration,
  type AiProviderAdapter,
  type TextRequest,
  type TextResult,
} from '@brandspace/ai-gateway';
import { CreditLedgerService } from '@brandspace/entitlements';
import {
  CopilotOrchestrator,
  parseCopilotPolicy,
  pruneCopilot,
  resolveLiveAuthorization,
  runAgentTurn,
  type AgentEvent,
  type LiveAuthorization,
} from '@brandspace/copilot';
import { agentToolPort } from '../../apps/api/src/routes/copilot-agent';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PR A (smart Copilot, D-603/D-604) — ONE MESSAGE THROUGH THE REAL LOOP.
 *
 * The real orchestrator, the API's real tool port and the real gateway and
 * ledger, against a scripted provider: asked for a post, the model calls
 * `post__create_draft`, then answers. What is proven:
 *
 *   - the draft is the brand's, created by the person through the composer's
 *     own path, marked AI_GENERATED with the request that wrote it, audited
 *     as COPILOT — and it is a DRAFT (no slot, no approval, no publish);
 *   - the answer and its "worked on" are stored on the conversation; the
 *     message is charged ONCE (the tool step settled at zero);
 *   - another workspace cannot read, list or count that message;
 *   - the port refuses a brand outside the person's scope, and a tool the
 *     person has no permission for, with nothing written.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let auth: LiveAuthorization;
let gateway: AiGateway;
const PRICE = 3_000;

const adapter: AiProviderAdapter = {
  key: 'scripted-agent',
  supportedModalities: ['text'],
  async testConnection() {
    return { ok: true, latencyMs: 1, message: 'ok' };
  },
  async generateText(request: TextRequest, _ctx: AdapterContext): Promise<TextResult> {
    const last = request.conversation?.at(-1);
    if (last?.role === 'user') {
      return {
        text: '',
        toolCalls: [
          {
            id: 'call_draft',
            name: 'post__create_draft',
            arguments: JSON.stringify({
              title: 'Autumn opening hours',
              caption: 'We are open late this autumn. Come by!',
              hashtags: ['#autumn'],
              platformKeys: ['instagram'],
              locale: 'EN',
            }),
          },
        ],
        usage: { promptTokens: 900, completionTokens: 30 },
        modelKey: request.modelKey,
      };
    }
    return {
      text: 'I made a draft post for you. It is not scheduled or published.',
      usage: { promptTokens: 1_000, completionTokens: 20 },
      modelKey: request.modelKey,
    };
  },
  classifyError: () => 'UNKNOWN',
};

const CONFIG: AiConfiguration = {
  providers: [
    {
      key: 'scripted-agent',
      baseUrl: 'https://scripted.invalid',
      apiKeySecretRef: null,
      status: 'active',
      timeoutMs: 30_000,
    },
  ],
  models: [
    {
      key: 'agent-model',
      providerKey: 'scripted-agent',
      modality: 'text',
      qualityTier: 'balanced',
      status: 'available',
      disableSwitch: false,
    },
  ],
  costBases: [
    {
      modelKey: 'agent-model',
      inputCostPerUnitMicroMinor: 75_000,
      outputCostPerUnitMicroMinor: 450_000,
      costUnit: '1k_tokens',
      costCurrency: 'USD',
    },
  ],
  routingRules: [
    {
      taskKey: 'copilot.chat',
      scope: 'global',
      planKey: null,
      workspaceId: null,
      primaryModelKey: 'agent-model',
      fallbackModelKeys: [],
      timeoutMs: 20_000,
      maxCostPerRequestMinor: null,
      priority: 0,
      parameters: {
        temperature: 0.7,
        maxOutputTokens: 1_200,
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
      taskKey: 'copilot.chat',
      modelKey: 'agent-model',
      baseMilliCredits: PRICE,
      perUnitMilliCredits: 0,
      unit: 'request',
    },
  ],
  budgets: {
    defaults: { creditsPerDayMilli: null, creditsPerMonthMilli: null, maxConcurrentRequests: null },
    perPlan: [],
  },
};

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const policy = parseCopilotPolicy(defaultPayload('copilot'));
const orchestrator = (db: TenantScopedClient) =>
  new CopilotOrchestrator({ db, workspaceId: fixtures.a.workspaceId, policy, gateway });

const port = (userId = fixtures.a.userId) =>
  agentToolPort({
    workspaceId: fixtures.a.workspaceId,
    userId,
    planKey: null,
    turnKey: `pra-${randomUUID()}`,
    facts: { planKey: null } as never,
    expiresAt: null,
  });

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  const resolved = await inA((db) =>
    resolveLiveAuthorization(db, fixtures.a.workspaceId, fixtures.a.userId),
  );
  if (!resolved) throw new Error('the fixture membership is missing');
  auth = resolved;
  const ledger = new CreditLedgerService({
    prisma: platform,
    policy: {
      hardStopAtZero: true,
      purchasedPackExpiryMonths: 12,
      promotionalExpiryMonths: 3,
      planGrantExpiryMonths: 0,
      lowBalanceThresholdPercents: [],
      reservationTimeoutSeconds: 900,
    },
  });
  await ledger.grant({
    workspaceId: fixtures.a.workspaceId,
    source: 'PLAN_GRANT',
    credits: 50,
    reason: 'pr-a agent fixture',
    idempotencyKey: `pra-agent-${randomUUID()}`,
  });
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters: new Map([['scripted-agent', adapter]]),
    configuration: { load: async () => CONFIG },
    credentials: { resolve: async () => null },
    environment: 'DEVELOPMENT',
  });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('PR A · one message through the real loop', () => {
  it('a draft by the person, AI_GENERATED, audited as COPILOT; the answer stored with its work; charged once', async () => {
    const session = await inA((db) =>
      orchestrator(db).openSession({
        authorization: auth,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
    const wallet = async () =>
      (
        await platform.creditWallet.findUniqueOrThrow({
          where: { workspaceId: fixtures.a.workspaceId },
        })
      ).balanceMilliCredits;
    const before = await wallet();
    const events: AgentEvent[] = [];
    const key = `pra-${randomUUID()}`;
    const result = await runAgentTurn(
      {
        gateway,
        run: (fn) => inA((db) => fn(orchestrator(db))),
        tools: port(),
        emit: (event) => events.push(event),
        signal: new AbortController().signal,
        limits: { maxRounds: 3, maxInputTokens: 24_000, autoSpendLimitMilli: 30_000n },
      },
      {
        workspaceId: fixtures.a.workspaceId,
        sessionId: session.id,
        request: 'Write a post about our autumn opening hours.',
        authorization: auth,
        planKey: null,
        idempotencyKey: key,
        expiresAt: null,
      },
    );

    expect(result.answer).toBe('I made a draft post for you. It is not scheduled or published.');
    const draft = events.find((event) => event.type === 'draft');
    expect(draft).toMatchObject({ type: 'draft', title: 'Autumn opening hours' });
    const itemId = draft?.type === 'draft' ? draft.contentItemId : '';

    const item = await platform.contentItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item).toMatchObject({
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      status: 'DRAFT',
      origin: 'AI_GENERATED',
      createdByUserId: fixtures.a.userId,
    });
    expect(item.aiRequestId).not.toBeNull();
    const variants = await platform.contentVariant.findMany({ where: { contentItemId: itemId } });
    expect(variants.map((v) => [v.platformKey, v.body])).toEqual([
      ['instagram', 'We are open late this autumn. Come by!'],
    ]);
    expect(await platform.calendarSlot.count({ where: { contentItemId: itemId } })).toBe(0);
    const audit = await platform.auditEvent.findFirstOrThrow({
      where: { resourceId: itemId, action: 'content.item.authored' },
    });
    expect(audit.actorType).toBe('COPILOT');
    expect(audit.actorId).toBe(fixtures.a.userId);

    const answer = await platform.copilotMessage.findFirstOrThrow({
      where: { sessionId: session.id, idempotencyKey: `${key}:assistant` },
    });
    expect(answer.body).toBe(result.answer);
    expect(answer.activity).toEqual({
      worked: [{ key: 'post.create_draft', state: 'done', contentItemId: itemId }],
    });
    const asked = await platform.copilotMessage.findFirstOrThrow({
      where: { sessionId: session.id, idempotencyKey: key, role: 'USER' },
    });
    expect(asked.status).toBe('complete');

    // Charged once: the tool step settled at zero, the answer at the price.
    const requests = await platform.aiRequest.findMany({
      where: {
        workspaceId: fixtures.a.workspaceId,
        idempotencyKey: { startsWith: `copilot:${key}:` },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(requests.map((r) => r.creditsChargedMilli)).toEqual([0n, BigInt(PRICE)]);
    expect(await wallet()).toBe(before - BigInt(PRICE));

    // Another workspace cannot read, list or count it.
    expect(await inB((db) => db.copilotMessage.count({ where: { sessionId: session.id } }))).toBe(
      0,
    );
    expect(await inB((db) => db.contentItem.findFirst({ where: { id: itemId } }))).toBeNull();
  });

  it('the port refuses a brand outside the person’s scope, and writes nothing', async () => {
    const outcome = await port().run({
      key: 'post.create_draft',
      args: { title: 't', caption: 'c', platformKeys: ['instagram'] },
      brandId: fixtures.b.brandId,
      aiRequestId: '',
      callId: 'x1',
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.content).toMatch(/^ERROR:/);
    expect(
      await platform.contentItem.count({ where: { brandId: fixtures.b.brandId, title: 't' } }),
    ).toBe(0);
  });

  it('a person without the permission is refused by the port, even if a tool were asked for', async () => {
    const outsider = await platform.user.create({
      data: {
        email: `pra-out-${randomUUID()}@example.local`,
        name: 'Out',
        status: 'ACTIVE',
        timezone: 'UTC',
      },
    });
    const outcome = await port(outsider.id).run({
      key: 'brand.profile',
      args: {},
      brandId: fixtures.a.brandId,
      aiRequestId: '',
      callId: 'x2',
    });
    expect(outcome.ok).toBe(false);
  });

  it('owner condition: the retention purge clears "activity" with the words', async () => {
    const session = await inA((db) =>
      orchestrator(db).openSession({
        authorization: auth,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
    const past = new Date(Date.now() - 60_000);
    const row = await platform.copilotMessage.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        sessionId: session.id,
        role: 'ASSISTANT',
        body: 'An answer whose window has passed.',
        correlationId: randomUUID(),
        expiresAt: past,
        activity: { worked: [{ key: 'post.create_draft', state: 'done' }] },
      },
    });
    let purged = 0;
    // The purge is bounded per pass; other suites' expired rows may come first.
    for (let pass = 0; pass < 50; pass += 1) {
      const left = await platform.copilotMessage.findUniqueOrThrow({ where: { id: row.id } });
      if (left.body === null) break;
      purged += (await pruneCopilot({ prisma: platform, policy, clock: { now: () => new Date() } }))
        .messageBodiesPurged;
    }
    expect(purged).toBeGreaterThan(0);
    const after = await platform.copilotMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.body).toBeNull();
    expect(after.bodyPurgedAt).not.toBeNull();
    expect(after.activity).toBeNull();
  });
});
