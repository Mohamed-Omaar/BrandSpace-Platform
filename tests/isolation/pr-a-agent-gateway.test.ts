import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AiGateway,
  type AdapterContext,
  type AiConfiguration,
  type AiProviderAdapter,
  type TextRequest,
  type TextResult,
} from '@brandspace/ai-gateway';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';

/**
 * PR A (smart Copilot, D-604) — WHAT THE GATEWAY GUARANTEES THE TOOL LOOP,
 * against the real ledger and `ai_request`.
 *
 *   - a step that only asked for tools settles at ZERO credits (its provider
 *     cost is still recorded); the answering step is charged the price;
 *   - Stop aborts the running call: the request ends CANCELLED, the
 *     reservation is released, the wallet is untouched — never retried;
 *   - an image goes only to a model declared to read images; a model that is
 *     not is skipped like an unavailable one.
 */

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};
const NO_LIMITS = {
  creditsPerDayMilli: null,
  creditsPerMonthMilli: null,
  maxConcurrentRequests: null,
};
const PRICE = 3_000;

let platform: PrismaClient;
let ledger: CreditLedgerService;
let gateway: AiGateway;
const CREATED: string[] = [];
const seen: { model: string; request: TextRequest }[] = [];

/** A scripted provider: tool calls, an answer, or a slow stream Stop can land in. */
const adapter: AiProviderAdapter = {
  key: 'scripted',
  supportedModalities: ['text'],
  async testConnection() {
    return { ok: true, latencyMs: 1, message: 'ok' };
  },
  async generateText(request: TextRequest, ctx: AdapterContext): Promise<TextResult> {
    seen.push({ model: request.modelKey, request });
    const last = request.conversation?.at(-1);
    const text = last?.role === 'user' ? last.text : '';
    if (text.includes('slowly')) {
      for (let i = 0; i < 100; i += 1) {
        if (ctx.signal.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        request.onDelta?.(`word${i} `);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (text.includes('tools')) {
      return {
        text: '',
        toolCalls: [{ id: 'c1', name: 'calendar__lookup', arguments: '{}' }],
        usage: { promptTokens: 1_000, completionTokens: 10 },
        modelKey: request.modelKey,
      };
    }
    return {
      text: 'The answer.',
      usage: { promptTokens: 1_000, completionTokens: 20 },
      modelKey: request.modelKey,
    };
  },
  classifyError(error) {
    return error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : 'UNKNOWN';
  },
};

function configuration(primary = 'reader'): AiConfiguration {
  return {
    providers: [
      {
        key: 'scripted',
        baseUrl: 'https://scripted.invalid',
        apiKeySecretRef: null,
        status: 'active',
        timeoutMs: 30_000,
      },
    ],
    models: [
      {
        key: 'blind',
        providerKey: 'scripted',
        modality: 'text',
        qualityTier: 'fast',
        status: 'available',
        disableSwitch: false,
      },
      {
        key: 'reader',
        providerKey: 'scripted',
        modality: 'text',
        qualityTier: 'balanced',
        status: 'available',
        disableSwitch: false,
        features: { vision: true },
      } as never,
    ],
    costBases: ['blind', 'reader'].map((modelKey) => ({
      modelKey,
      inputCostPerUnitMicroMinor: 75_000,
      outputCostPerUnitMicroMinor: 450_000,
      costUnit: '1k_tokens' as const,
      costCurrency: 'USD',
    })),
    routingRules: [
      {
        taskKey: 'copilot.chat',
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: primary,
        fallbackModelKeys: primary === 'blind' ? ['reader'] : [],
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
        // Three attempts: a Stop must still never be retried.
        retryPolicy: { maxAttempts: 3, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
    ],
    creditRules: ['blind', 'reader'].map((modelKey) => ({
      taskKey: 'copilot.chat',
      modelKey,
      baseMilliCredits: PRICE,
      perUnitMilliCredits: 0,
      unit: 'request' as const,
    })),
    budgets: { defaults: NO_LIMITS, perPlan: [] },
  };
}
let active = configuration();

async function workspace(): Promise<string> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: { email: `pra-${run}@example.local`, name: 'PR A', status: 'ACTIVE', timezone: 'UTC' },
  });
  await platform.workspace.create({
    data: {
      id: run,
      workspaceId: run,
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      slug: `pra-${run.slice(0, 12)}`,
      name: 'PR A agent',
      ownerUserId: user.id,
      status: 'ACTIVE',
    },
  });
  await platform.creditWallet.create({ data: { workspaceId: run } });
  await ledger.grant({
    workspaceId: run,
    source: 'PLAN_GRANT',
    credits: 50,
    reason: 'pr-a fixture',
    idempotencyKey: `pra-grant-${run}`,
  });
  CREATED.push(run);
  return run;
}

const balance = async (workspaceId: string) =>
  (await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } })).balanceMilliCredits;

const turn = (workspaceId: string, text: string, extra: Record<string, unknown> = {}) => ({
  workspaceId,
  userId: null,
  taskKey: 'copilot.chat',
  planKey: null,
  idempotencyKey: `pra-${crypto.randomUUID()}`,
  input: {
    kind: 'text' as const,
    prompt: 'You are the Copilot.',
    conversation: [{ role: 'user' as const, text }],
    tools: [{ name: 'calendar__lookup', description: 'Calendar', parameters: { type: 'object' } }],
  },
  chargeWhen: (output: { kind: string; toolCalls?: readonly unknown[] }) =>
    !(output.kind === 'text' && (output.toolCalls?.length ?? 0) > 0),
  ...extra,
});

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters: new Map([['scripted', adapter]]),
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

describe('PR A · the gateway under the tool loop', () => {
  it('a step that asked for tools settles at zero; its cost is still recorded', async () => {
    active = configuration();
    const ws = await workspace();
    const before = await balance(ws);
    const result = await gateway.execute(turn(ws, 'use tools please'));
    expect(result.status).toBe('SUCCEEDED');
    expect(result.output).toMatchObject({
      kind: 'text',
      toolCalls: [{ name: 'calendar__lookup' }],
    });
    expect(result.creditsChargedMilli).toBe(0n);
    expect(result.providerCostMicroMinor).toBeGreaterThan(0n);
    expect(await balance(ws)).toBe(before);
    expect(
      await platform.creditReservation.count({ where: { workspaceId: ws, status: 'OPEN' } }),
    ).toBe(0);
  });

  it('the answering step is charged the message price', async () => {
    active = configuration();
    const ws = await workspace();
    const before = await balance(ws);
    const result = await gateway.execute(turn(ws, 'just answer'));
    expect(result.creditsChargedMilli).toBe(BigInt(PRICE));
    expect(await balance(ws)).toBe(before - BigInt(PRICE));
  });

  it('Stop: the running call ends CANCELLED, released, nothing charged, never retried', async () => {
    active = configuration();
    const ws = await workspace();
    const before = await balance(ws);
    const stop = new AbortController();
    const pieces: string[] = [];
    seen.length = 0;
    setTimeout(() => stop.abort(), 150);
    const result = await gateway.execute(
      turn(ws, 'answer slowly', { signal: stop.signal, onDelta: (t: string) => pieces.push(t) }),
    );
    expect(pieces.length).toBeGreaterThan(0);
    expect(result.status).toBe('CANCELLED');
    expect(result.creditsChargedMilli).toBe(0n);
    expect(seen).toHaveLength(1);
    expect(await balance(ws)).toBe(before);
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    expect(row.status).toBe('CANCELLED');
    expect(
      await platform.creditReservation.count({ where: { workspaceId: ws, status: 'OPEN' } }),
    ).toBe(0);
  });

  it('an image is sent only to a model that reads images: the blind one is skipped', async () => {
    active = configuration('blind');
    const ws = await workspace();
    seen.length = 0;
    const result = await gateway.execute({
      ...turn(ws, 'just answer'),
      input: {
        kind: 'text',
        prompt: 'You are the Copilot.',
        conversation: [
          {
            role: 'user',
            text: 'What is this?',
            images: [{ mimeType: 'image/png', base64: 'iVBORw0KGgo=' }],
          },
        ],
      },
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(result.attemptedModelKeys).toEqual(['blind', 'reader']);
    expect(seen.map((entry) => entry.model)).toEqual(['reader']);
  });
});
