import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AiGateway,
  type AiConfiguration,
  type AiProviderAdapter,
  type ReasoningEffort,
  type TextRequest,
  type TextResult,
} from '@brandspace/ai-gateway';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';

/**
 * NO TEMPERATURE FOR A REQUEST THAT REASONS (owner, 2026-11-12), through the
 * real gateway, ledger and `ai_request`.
 *
 * The stand-in provider behaves as OpenAI documents: a model that reasons
 * (here `sol`, declared `defaultReasoningEffort: medium`) refuses a request
 * carrying `temperature` with HTTP 400. Before the fix, `strategy.generate`
 * and `plan.monthly` on such a model failed every time: INVALID_REQUEST is
 * neither retried nor sent to the fallback. Now the gateway leaves the
 * temperature out exactly when the request reasons.
 */

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

class ProviderRefusal extends Error {
  readonly status = 400;
}

let platform: PrismaClient;
let ledger: CreditLedgerService;
let gateway: AiGateway;
const CREATED: string[] = [];
const seen: TextRequest[] = [];
const REASONS_BY_DEFAULT = new Set(['sol']);

const adapter: AiProviderAdapter = {
  key: 'stand-in',
  supportedModalities: ['text'],
  async testConnection() {
    return { ok: true, latencyMs: 1, message: 'ok' };
  },
  async generateText(request: TextRequest): Promise<TextResult> {
    seen.push(request);
    const effort =
      request.reasoningEffort ?? (REASONS_BY_DEFAULT.has(request.modelKey) ? 'medium' : 'none');
    if (effort !== 'none' && request.temperature !== undefined) {
      throw new ProviderRefusal(
        "Unsupported parameter: 'temperature' is not supported with this model.",
      );
    }
    return {
      text: '{"ok":true}',
      usage: { promptTokens: 500, completionTokens: 50 },
      modelKey: request.modelKey,
    };
  },
  classifyError(error) {
    return error instanceof ProviderRefusal ? 'INVALID_REQUEST' : 'UNKNOWN';
  },
};

function configuration(input: {
  solDefault: ReasoningEffort | null;
  routeEffort?: ReasoningEffort | null;
  primary?: string;
  temperature?: number;
}): AiConfiguration {
  const model = (key: string, defaultReasoningEffort: ReasoningEffort | null) =>
    ({
      key,
      providerKey: 'stand-in',
      modality: 'text',
      qualityTier: 'balanced',
      status: 'available',
      disableSwitch: false,
      defaultReasoningEffort,
    }) as never;
  const tasks = ['strategy.generate', 'plan.monthly'];
  return {
    providers: [
      {
        key: 'stand-in',
        baseUrl: 'https://stand-in.invalid',
        apiKeySecretRef: null,
        status: 'active',
        timeoutMs: 30_000,
      },
    ],
    models: [model('sol', input.solDefault), model('mini', null)],
    costBases: ['sol', 'mini'].map((modelKey) => ({
      modelKey,
      inputCostPerUnitMicroMinor: 75_000,
      outputCostPerUnitMicroMinor: 450_000,
      costUnit: '1k_tokens' as const,
      costCurrency: 'USD',
    })),
    routingRules: tasks.map((taskKey) => ({
      taskKey,
      scope: 'global' as const,
      planKey: null,
      workspaceId: null,
      primaryModelKey: input.primary ?? 'sol',
      fallbackModelKeys: ['mini'],
      timeoutMs: 20_000,
      maxCostPerRequestMinor: null,
      priority: 0,
      parameters: {
        temperature: input.temperature ?? 0.7,
        maxOutputTokens: 2_000,
        promptTemplateVersion: 1,
        persistOutput: false,
        outputRetentionDays: null,
        ...(input.routeEffort !== undefined ? { reasoningEffort: input.routeEffort } : {}),
      },
      retryPolicy: { maxAttempts: 2, backoff: 'none' as const, initialDelayMs: 0, jitter: false },
      moderateInput: false,
      moderationModelKey: null,
    })),
    creditRules: tasks.flatMap((taskKey) =>
      ['sol', 'mini'].map((modelKey) => ({
        taskKey,
        modelKey,
        baseMilliCredits: 2_000,
        perUnitMilliCredits: 0,
        unit: 'request' as const,
      })),
    ),
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
let active = configuration({ solDefault: 'medium' });

async function workspace(): Promise<string> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `rnt-${run}@example.local`,
      name: 'Reasoning',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  await platform.workspace.create({
    data: {
      id: run,
      workspaceId: run,
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      slug: `rnt-${run.slice(0, 12)}`,
      name: 'Reasoning',
      ownerUserId: user.id,
      status: 'ACTIVE',
    },
  });
  await platform.creditWallet.create({ data: { workspaceId: run } });
  await ledger.grant({
    workspaceId: run,
    source: 'PLAN_GRANT',
    credits: 50,
    reason: 'reasoning fixture',
    idempotencyKey: `rnt-grant-${run}`,
  });
  CREATED.push(run);
  return run;
}

const ask = (workspaceId: string, taskKey: string) =>
  gateway.execute({
    workspaceId,
    userId: null,
    taskKey,
    planKey: null,
    idempotencyKey: `rnt-${crypto.randomUUID()}`,
    input: { kind: 'text', prompt: 'Write the plan as JSON.' },
  });

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters: new Map([['stand-in', adapter]]),
    configuration: { load: async () => active },
    credentials: { resolve: async () => null },
    environment: 'DEVELOPMENT',
  });
}, 90_000);

afterAll(async () => {
  if (platform && CREATED.length > 0) {
    await platform.creditReservation.deleteMany({ where: { workspaceId: { in: CREATED } } });
  }
  await platform?.$disconnect();
});

describe('reasoning · strategy and the monthly plan on a reasoning model', () => {
  for (const taskKey of ['strategy.generate', 'plan.monthly']) {
    it(`${taskKey} on a model declared to reason succeeds on it, sent no temperature`, async () => {
      active = configuration({ solDefault: 'medium' });
      const ws = await workspace();
      seen.length = 0;
      const result = await ask(ws, taskKey);
      expect(result.status).toBe('SUCCEEDED');
      expect(result.modelKey).toBe('sol');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.temperature).toBeUndefined();
      expect(seen[0]!.reasoningEffort).toBeUndefined();
    });
  }

  it('WHAT STAGING DOES TODAY (no reasoning declared): the temperature goes out, the provider refuses, nothing falls back', async () => {
    active = configuration({ solDefault: null });
    const ws = await workspace();
    seen.length = 0;
    const result = await ask(ws, 'strategy.generate');
    expect(result.status).toBe('FAILED');
    expect(seen.map((r) => [r.modelKey, r.temperature])).toEqual([['sol', 0.7]]);
    const row = await platform.aiRequest.findFirstOrThrow({
      where: { workspaceId: ws },
      select: { failureClass: true, creditsChargedMilli: true },
    });
    expect(row).toEqual({ failureClass: 'INVALID_REQUEST', creditsChargedMilli: 0n });
  });
});

describe('reasoning · a temperature set explicitly on the route (staging v2: temperature 1)', () => {
  for (const taskKey of ['strategy.generate', 'plan.monthly']) {
    it(`${taskKey} with temperature 1 on the route: still not sent to the reasoning model, which succeeds`, async () => {
      active = configuration({ solDefault: 'medium', temperature: 1 });
      const ws = await workspace();
      seen.length = 0;
      const result = await ask(ws, taskKey);
      expect(result.status).toBe('SUCCEEDED');
      expect(result.modelKey).toBe('sol');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.temperature).toBeUndefined();
    });
  }

  it('the same route on a model that does not reason sends its temperature of 1', async () => {
    active = configuration({ solDefault: 'medium', temperature: 1, primary: 'mini' });
    const ws = await workspace();
    seen.length = 0;
    expect((await ask(ws, 'strategy.generate')).status).toBe('SUCCEEDED');
    expect(seen[0]).toMatchObject({ modelKey: 'mini', temperature: 1 });
  });

  it('a route naming an effort with temperature 1: the effort is sent, the temperature is not', async () => {
    active = configuration({ solDefault: null, temperature: 1, routeEffort: 'high' });
    const ws = await workspace();
    seen.length = 0;
    expect((await ask(ws, 'plan.monthly')).status).toBe('SUCCEEDED');
    expect(seen[0]!.temperature).toBeUndefined();
    expect(seen[0]!.reasoningEffort).toBe('high');
  });
});

describe('reasoning · the route decides when it names an effort', () => {
  it('a model that does not reason still gets its temperature', async () => {
    active = configuration({ solDefault: 'medium', primary: 'mini' });
    const ws = await workspace();
    seen.length = 0;
    expect((await ask(ws, 'plan.monthly')).status).toBe('SUCCEEDED');
    expect(seen[0]).toMatchObject({ modelKey: 'mini', temperature: 0.7 });
    expect(seen[0]!.reasoningEffort).toBeUndefined();
  });

  it('a route asking for `high` sends that effort and no temperature, even to a model with no default', async () => {
    active = configuration({ solDefault: null, routeEffort: 'high' });
    const ws = await workspace();
    seen.length = 0;
    expect((await ask(ws, 'strategy.generate')).status).toBe('SUCCEEDED');
    expect(seen[0]!.temperature).toBeUndefined();
    expect(seen[0]!.reasoningEffort).toBe('high');
  });

  it('a route asking for `none` sends `none` and the temperature', async () => {
    active = configuration({ solDefault: 'medium', routeEffort: 'none' });
    const ws = await workspace();
    seen.length = 0;
    expect((await ask(ws, 'strategy.generate')).status).toBe('SUCCEEDED');
    expect(seen[0]).toMatchObject({ temperature: 0.7, reasoningEffort: 'none' });
  });
});
