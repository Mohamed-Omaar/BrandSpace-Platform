import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AiGateway,
  MockProviderAdapter,
  measurePlatformSpend,
  type AiConfiguration,
  type AiGatewayRequest,
  type AiProviderAdapter,
  type PlatformBudgetLimits,
  type PlatformThresholdCrossing,
} from '@brandspace/ai-gateway';
import { OpenAiAdapter } from '@brandspace/ai-gateway/adapters';
import { pinnedHttpsTransport, pinnedLookup } from '@brandspace/ai-gateway/egress';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';
import { vaultCredentials } from '../../apps/api/src/ai-gateway-factory';

/**
 * D-573 — THE PLATFORM'S OWN AI PROVIDER, THROUGH THE REAL GATEWAY AND A REAL
 * DATABASE. The provider is a local server answering with recorded response
 * shapes; the adapter reaches it through the production transport. Nothing here
 * calls a real provider.
 *
 * What is proven: routing and fallback between the real adapter and the mock;
 * every failure class charges nothing; an idempotent retry charges once; the
 * platform ceiling's sum rule (actual cost of settled requests plus the
 * estimate of in-flight ones, released, failed and refused counting zero), its
 * refusal, its exact-boundary admission and CONCURRENT admission; the owner's
 * 80%/100% hook; and a canary credential found in no row, audit event, log,
 * error, result or configuration document.
 */

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

/** A canary in the shape a real key has. If it appears anywhere, it leaked. */
const CANARY = `sk-proj-d573canary${randomUUID().replace(/-/g, '')}`;
const CANARY_REF = 'integration/ai/openai/development/apiKey';

const PROVIDER_MODEL = 'text-primary';
const MOCK_MODEL = 'mock-fast';
const TASK = 'caption.generate';

type Reply = { status: number; body: unknown; delayMs?: number; hold?: boolean };
let server: Server;
let port = 0;
let script: Reply[] = [];
let calls = 0;
const authorizations: string[] = [];
const held: (() => void)[] = [];

function completion(content: string, finish = 'stop') {
  return {
    model: PROVIDER_MODEL,
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 200, completion_tokens: 100 },
  };
}

const CAPTION = JSON.stringify({
  title: 'Launch',
  variants: [{ platformKey: 'instagram', body: 'A caption.', hashtags: [] }],
});

let platform: PrismaClient;
let ledger: CreditLedgerService;
const mock = new MockProviderAdapter();
const crossings: PlatformThresholdCrossing[] = [];
const thrown: unknown[] = [];
const results: unknown[] = [];
const logged: string[] = [];
const WORKSPACES: string[] = [];
let startedAt: Date;

let platformBudget: PlatformBudgetLimits | undefined;
let providerStatus: 'active' | 'validated' = 'active';
let chain: { primary: string; fallbacks: string[]; timeoutMs: number } = {
  primary: PROVIDER_MODEL,
  fallbacks: [MOCK_MODEL],
  timeoutMs: 5_000,
};

function configuration(): AiConfiguration {
  return {
    providers: [
      {
        key: 'openai',
        adapterKey: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKeySecretRef: CANARY_REF,
        status: providerStatus,
        timeoutMs: 30_000,
      },
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
        key: PROVIDER_MODEL,
        providerKey: 'openai',
        modality: 'text',
        qualityTier: 'balanced',
        status: 'beta',
        disableSwitch: false,
      },
      {
        key: MOCK_MODEL,
        providerKey: 'mock',
        modality: 'text',
        qualityTier: 'fast',
        status: 'beta',
        disableSwitch: false,
      },
    ],
    costBases: [
      {
        modelKey: PROVIDER_MODEL,
        inputCostPerUnitMicroMinor: 250_000,
        outputCostPerUnitMicroMinor: 1_000_000,
        costUnit: '1k_tokens',
        costCurrency: 'USD',
      },
    ],
    routingRules: [
      {
        taskKey: TASK,
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: chain.primary,
        fallbackModelKeys: chain.fallbacks,
        timeoutMs: chain.timeoutMs,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.5,
          maxOutputTokens: 400,
          promptTemplateVersion: 1,
          persistOutput: false,
          outputRetentionDays: null,
        },
        retryPolicy: { maxAttempts: 2, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
    ],
    creditRules: [PROVIDER_MODEL, MOCK_MODEL].map((modelKey) => ({
      taskKey: TASK,
      modelKey,
      baseMilliCredits: 100,
      perUnitMilliCredits: 50,
      unit: '1k_tokens' as const,
    })),
    budgets: {
      defaults: {
        creditsPerDayMilli: null,
        creditsPerMonthMilli: null,
        maxConcurrentRequests: null,
      },
      perPlan: [],
    },
    ...(platformBudget ? { platformBudget } : {}),
    allowedHosts: [],
  };
}

function makeGateway(): AiGateway {
  const openai = new OpenAiAdapter({
    transportFor: (allowedHosts) =>
      pinnedHttpsTransport(
        allowedHosts,
        pinnedLookup(
          (_host, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
          (address) => address === '127.0.0.1',
        ),
        { request: httpRequest, port },
      ),
  });
  return new AiGateway({
    prisma: platform,
    ledger,
    adapters: new Map<string, AiProviderAdapter>([
      ['openai', openai],
      ['mock', mock],
    ]),
    configuration: { load: async () => configuration() },
    // The API's own credential source, over a stand-in vault.
    credentials: vaultCredentials(async (ref) => {
      if (ref === CANARY_REF) return CANARY;
      throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
    }),
    environment: 'DEVELOPMENT',
    random: () => 0.5,
    onPlatformThreshold: (found) => {
      crossings.push(...found);
    },
  });
}

let gateway: AiGateway;

async function freshWorkspace(credits = 500): Promise<string> {
  const run = randomUUID();
  const user = await platform.user.create({
    data: { email: `d573-${run}@example.local`, name: 'D-573', status: 'ACTIVE', timezone: 'UTC' },
  });
  const workspace = await platform.workspace.create({
    data: {
      id: run,
      workspaceId: run,
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      slug: `d573-${run.slice(0, 12)}`,
      name: 'D-573 workspace',
      ownerUserId: user.id,
      status: 'ACTIVE',
    },
  });
  await platform.creditWallet.create({ data: { workspaceId: workspace.id } });
  WORKSPACES.push(workspace.id);
  await ledger.grant({
    workspaceId: workspace.id,
    source: 'PLAN_GRANT',
    credits,
    reason: 'd573 fixture',
    idempotencyKey: `d573-grant-${run}`,
  });
  return workspace.id;
}

function request(workspaceId: string, overrides: Partial<AiGatewayRequest> = {}): AiGatewayRequest {
  return {
    workspaceId,
    userId: null,
    taskKey: TASK,
    planKey: null,
    idempotencyKey: `d573-${randomUUID()}`,
    input: { kind: 'text', prompt: 'Write a launch caption.' },
    ...overrides,
  };
}

async function run(req: AiGatewayRequest, using: AiGateway = gateway) {
  try {
    const result = await using.execute(req);
    results.push(result);
    return result;
  } catch (error) {
    thrown.push(error);
    throw error;
  }
}

async function wallet(workspaceId: string) {
  const row = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
  return { balance: row.balanceMilliCredits, reserved: row.reservedMilliCredits };
}

const spendNow = () => measurePlatformSpend(platform, new Date());

beforeAll(async () => {
  startedAt = new Date();
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      ...rest: never[]
    ) => {
      logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return original(chunk, ...rest);
    }) as typeof stream.write);
  }

  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      authorizations.push(String(req.headers['authorization'] ?? ''));
      const next = script.shift() ?? { status: 200, body: completion(CAPTION) };
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
      };
      if (next.hold) held.push(send);
      else if (next.delayMs) setTimeout(send, next.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
  gateway = makeGateway();
}, 90_000);

afterAll(async () => {
  for (const release of held.splice(0)) release();
  vi.restoreAllMocks();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (platform && WORKSPACES.length > 0) {
    await platform.aiRequest.deleteMany({
      where: {
        workspaceId: { in: WORKSPACES },
        status: { in: ['PENDING', 'RESERVED', 'RUNNING'] },
      },
    });
    await platform.creditReservation.deleteMany({ where: { workspaceId: { in: WORKSPACES } } });
  }
  await platform?.$disconnect();
});

describe('D-573 · routing and fallback through the real gateway', () => {
  it('the provider answers: charged once, at the credit rule, with its cost recorded', async () => {
    platformBudget = undefined;
    providerStatus = 'active';
    chain = { primary: PROVIDER_MODEL, fallbacks: [MOCK_MODEL], timeoutMs: 5_000 };
    const workspaceId = await freshWorkspace();
    const before = await wallet(workspaceId);
    const callsBefore = calls;

    const result = await run(request(workspaceId));

    expect(result.status).toBe('SUCCEEDED');
    expect(result.modelKey).toBe(PROVIDER_MODEL);
    expect(calls - callsBefore).toBe(1);
    expect(authorizations.at(-1)).toBe(`Bearer ${CANARY}`);
    const after = await wallet(workspaceId);
    expect(before.balance - after.balance).toBe(result.creditsChargedMilli);
    expect(after.reserved).toBe(0n);
    // 200 input tokens at 250,000 and 100 output at 1,000,000 per 1k.
    expect(result.providerCostMicroMinor).toBe(150_000n);
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    expect(row.providerCostEstimateMicroMinor).toBeGreaterThanOrEqual(row.providerCostMicroMinor);
  });

  it('a provider outage falls back to the next model; still one charge', async () => {
    const workspaceId = await freshWorkspace();
    const before = await wallet(workspaceId);
    script = [
      { status: 503, body: 'unavailable' },
      { status: 503, body: 'unavailable' },
    ];
    const result = await run(request(workspaceId));
    expect(result.status).toBe('SUCCEEDED');
    expect(result.modelKey).toBe(MOCK_MODEL);
    expect(result.attemptedModelKeys).toEqual([PROVIDER_MODEL, PROVIDER_MODEL, MOCK_MODEL]);
    const after = await wallet(workspaceId);
    expect(before.balance - after.balance).toBe(result.creditsChargedMilli);
  });

  it('a provider that is not active is never called', async () => {
    providerStatus = 'validated';
    const workspaceId = await freshWorkspace();
    const callsBefore = calls;
    const result = await run(request(workspaceId));
    providerStatus = 'active';
    expect(result.status).toBe('SUCCEEDED');
    expect(result.modelKey).toBe(MOCK_MODEL);
    expect(calls).toBe(callsBefore);
  });

  it('an idempotent retry replays and charges once', async () => {
    const workspaceId = await freshWorkspace();
    const before = await wallet(workspaceId);
    const req = request(workspaceId);
    const first = await run(req);
    const callsBetween = calls;
    const second = await run(req);
    expect(second.replayed).toBe(true);
    expect(calls).toBe(callsBetween);
    const after = await wallet(workspaceId);
    expect(before.balance - after.balance).toBe(first.creditsChargedMilli);
  });
});

describe('D-573 · no failure is ever charged', () => {
  const cases: [string, Reply, string][] = [
    ['auth', { status: 401, body: { error: { code: 'invalid_api_key' } } }, 'AUTH_ERROR'],
    [
      'quota',
      { status: 429, body: { error: { type: 'insufficient_quota', code: 'insufficient_quota' } } },
      'QUOTA_EXCEEDED',
    ],
    ['rate', { status: 429, body: { error: { code: 'rate_limit_exceeded' } } }, 'RATE_LIMITED'],
    [
      'context',
      { status: 400, body: { error: { code: 'context_length_exceeded' } } },
      'CONTEXT_TOO_LONG',
    ],
    ['filtered', { status: 200, body: completion('', 'content_filter') }, 'CONTENT_FILTERED'],
    [
      'invalid',
      { status: 400, body: { error: { type: 'invalid_request_error' } } },
      'INVALID_REQUEST',
    ],
    ['model', { status: 404, body: { error: { code: 'model_not_found' } } }, 'MODEL_UNAVAILABLE'],
    [
      'provider',
      { status: 500, body: { error: { type: 'server_error' } } },
      'PROVIDER_UNAVAILABLE',
    ],
    ['shape', { status: 200, body: { choices: [] } }, 'PROVIDER_UNAVAILABLE'],
    ['unknown', { status: 418, body: {} }, 'UNKNOWN'],
    ['timeout', { status: 200, body: completion(CAPTION), delayMs: 3_000 }, 'TIMEOUT'],
  ];

  it.each(cases)(
    '%s: %s is recorded, released, and nothing is charged',
    async (_l, reply, expected) => {
      chain = {
        primary: PROVIDER_MODEL,
        fallbacks: [],
        timeoutMs: expected === 'TIMEOUT' ? 400 : 5_000,
      };
      const workspaceId = await freshWorkspace();
      const before = await wallet(workspaceId);
      script = [reply, reply];
      const result = await run(request(workspaceId));
      script = [];
      chain = { primary: PROVIDER_MODEL, fallbacks: [MOCK_MODEL], timeoutMs: 5_000 };

      expect(result.status === 'FAILED' || result.status === 'TIMEOUT').toBe(true);
      expect(result.failureClass).toBe(expected);
      expect(result.creditsChargedMilli).toBe(0n);
      expect(result.failureMessage ?? '').not.toContain(CANARY);
      const after = await wallet(workspaceId);
      expect(after.balance).toBe(before.balance);
      expect(after.reserved).toBe(0n);
      const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
      expect(row.providerCostMicroMinor).toBe(0n);
    },
  );
});

describe('D-573 · the platform ceiling', () => {
  let estimate = 0n;

  it('learns this request’s estimate from an admitted one', async () => {
    platformBudget = undefined;
    const workspaceId = await freshWorkspace();
    const result = await run(request(workspaceId));
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    estimate = row.providerCostEstimateMicroMinor;
    expect(estimate).toBeGreaterThan(0n);
  });

  it('the sum: actual cost of settled + estimate of in-flight; failed and refused count zero', async () => {
    platformBudget = undefined;
    const workspaceId = await freshWorkspace();
    const start = await spendNow();

    const settled = await run(request(workspaceId));
    expect(settled.status).toBe('SUCCEEDED');
    const afterSettled = await spendNow();
    expect(afterSettled.todayMicroMinor - start.todayMicroMinor).toBe(
      settled.providerCostMicroMinor,
    );

    script = [{ status: 400, body: { error: { type: 'invalid_request_error' } } }];
    chain = { primary: PROVIDER_MODEL, fallbacks: [], timeoutMs: 5_000 };
    const failed = await run(request(workspaceId));
    chain = { primary: PROVIDER_MODEL, fallbacks: [MOCK_MODEL], timeoutMs: 5_000 };
    expect(failed.status).toBe('FAILED');
    expect((await spendNow()).todayMicroMinor).toBe(afterSettled.todayMicroMinor);

    script = [{ status: 200, body: completion(CAPTION), hold: true }];
    const inFlight = run(request(workspaceId));
    await vi.waitFor(async () => {
      expect(await platform.aiRequest.count({ where: { workspaceId, status: 'RUNNING' } })).toBe(1);
    });
    expect((await spendNow()).todayMicroMinor - afterSettled.todayMicroMinor).toBe(estimate);
    for (const release of held.splice(0)) release();
    const landed = await inFlight;
    expect((await spendNow()).todayMicroMinor - afterSettled.todayMicroMinor).toBe(
      landed.providerCostMicroMinor,
    );

    // A refusal adds nothing either.
    const now = await spendNow();
    platformBudget = {
      providerCostPerDayMicroMinor: Number(now.todayMicroMinor),
      providerCostPerMonthMicroMinor: null,
      currency: 'USD',
    };
    await expect(run(request(workspaceId))).rejects.toMatchObject({ code: 'AI_PAUSED' });
    platformBudget = undefined;
    expect((await spendNow()).todayMicroMinor).toBe(now.todayMicroMinor);
  });

  it('past the daily ceiling: AI_PAUSED, no row, no reservation, the owner told at 100%', async () => {
    const workspaceId = await freshWorkspace();
    const before = await wallet(workspaceId);
    const now = await spendNow();
    platformBudget = {
      providerCostPerDayMicroMinor: Number(now.todayMicroMinor + estimate - 1n),
      providerCostPerMonthMicroMinor: null,
      currency: 'USD',
    };
    const fresh = makeGateway();
    crossings.length = 0;
    await expect(run(request(workspaceId), fresh)).rejects.toMatchObject({
      code: 'AI_PAUSED',
      httpStatus: 503,
      message: 'AI is paused right now. Please try again later.',
    });
    platformBudget = undefined;
    expect(await platform.aiRequest.count({ where: { workspaceId } })).toBe(0);
    expect(await wallet(workspaceId)).toEqual(before);
    expect(crossings.some((c) => c.period === 'day' && c.thresholdPercent === 100)).toBe(true);
  });

  it('exactly at the ceiling is admitted', async () => {
    const workspaceId = await freshWorkspace();
    const now = await spendNow();
    platformBudget = {
      providerCostPerDayMicroMinor: Number(now.todayMicroMinor + estimate),
      providerCostPerMonthMicroMinor: null,
      currency: 'USD',
    };
    const result = await run(request(workspaceId));
    platformBudget = undefined;
    expect(result.status).toBe('SUCCEEDED');
  });

  it('past the monthly ceiling: paused too', async () => {
    const workspaceId = await freshWorkspace();
    const now = await spendNow();
    platformBudget = {
      providerCostPerDayMicroMinor: null,
      providerCostPerMonthMicroMinor: Number(now.thisMonthMicroMinor + estimate - 1n),
      currency: 'USD',
    };
    await expect(run(request(workspaceId))).rejects.toMatchObject({ code: 'AI_PAUSED' });
    platformBudget = undefined;
  });

  it('twelve concurrent requests cannot share headroom: two fit, ten are paused', async () => {
    const workspaceId = await freshWorkspace(2_000);
    const now = await spendNow();
    platformBudget = {
      providerCostPerDayMicroMinor: Number(now.todayMicroMinor + estimate * 2n + estimate / 2n),
      providerCostPerMonthMicroMinor: null,
      currency: 'USD',
    };
    script = Array.from({ length: 12 }, () => ({
      status: 200,
      body: completion(CAPTION),
      hold: true,
    }));
    const outcomes = Array.from({ length: 12 }, () =>
      run(request(workspaceId)).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
    await vi.waitFor(
      async () => {
        expect(await platform.aiRequest.count({ where: { workspaceId, status: 'RUNNING' } })).toBe(
          2,
        );
      },
      { timeout: 10_000 },
    );
    for (const release of held.splice(0)) release();
    const settled = await Promise.all(outcomes);
    script = [];
    platformBudget = undefined;

    expect(settled.filter((o) => o.ok)).toHaveLength(2);
    const refused = settled.filter((o) => !o.ok);
    expect(refused).toHaveLength(10);
    for (const outcome of refused) {
      expect((outcome as { error: { code?: string } }).error.code).toBe('AI_PAUSED');
    }
    expect(await platform.aiRequest.count({ where: { workspaceId } })).toBe(2);
  });

  it('the owner is told at 80% once, however many requests cross it', async () => {
    const workspaceId = await freshWorkspace();
    const now = await spendNow();
    // After two admissions the day sits between 80% and 100%.
    const ceiling = ((now.todayMicroMinor + estimate * 2n) * 100n) / 85n;
    platformBudget = {
      providerCostPerDayMicroMinor: Number(ceiling),
      providerCostPerMonthMicroMinor: null,
      currency: 'USD',
    };
    const fresh = makeGateway();
    crossings.length = 0;
    await run(request(workspaceId), fresh);
    await run(request(workspaceId), fresh);
    await run(request(workspaceId), fresh).catch(() => undefined);
    platformBudget = undefined;
    const at80 = crossings.filter((c) => c.period === 'day' && c.thresholdPercent === 80);
    expect(at80).toHaveLength(1);
  });
});

describe('D-573 · the credential leaks nowhere', () => {
  const stringify = (value: unknown) =>
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

  it('was really used (the canary reached the provider)', () => {
    expect(authorizations).toContain(`Bearer ${CANARY}`);
  });

  it('is in no ai_request row, usage-ledger row or credit row', async () => {
    const requests = await platform.aiRequest.findMany({
      where: { workspaceId: { in: WORKSPACES } },
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(stringify(requests)).not.toContain(CANARY);
    const usage = await platform.aiUsageLedger.findMany({
      where: { workspaceId: { in: WORKSPACES } },
    });
    expect(stringify(usage)).not.toContain(CANARY);
    const reservations = await platform.creditReservation.findMany({
      where: { workspaceId: { in: WORKSPACES } },
    });
    expect(stringify(reservations)).not.toContain(CANARY);
  });

  it('is in no audit event written while this suite ran', async () => {
    const events = await platform.auditEvent.findMany({
      where: { occurredAt: { gte: startedAt } },
    });
    expect(stringify(events)).not.toContain(CANARY);
  });

  it('is in no configuration document', async () => {
    const documents = await platform.configurationVersion.findMany({ select: { payload: true } });
    expect(stringify(documents)).not.toContain(CANARY);
  });

  it('is in no log line, error or result', () => {
    expect(logged.join('\n')).not.toContain(CANARY);
    for (const error of thrown) {
      expect(stringify(error)).not.toContain(CANARY);
      expect(String((error as Error).message)).not.toContain(CANARY);
      expect(String((error as Error).stack ?? '')).not.toContain(CANARY);
    }
    expect(stringify(results)).not.toContain(CANARY);
  });
});
