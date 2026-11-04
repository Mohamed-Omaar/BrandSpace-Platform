import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AiGateway,
  IMAGE_ATTEMPT_TIMEOUT_MS,
  MockProviderAdapter,
  attemptTimeoutMsFor,
  fallsBackAfter,
  retriesAfter,
  type AdapterContext,
  type AiConfiguration,
  type AiGatewayRequest,
  type AiProviderAdapter,
} from '@brandspace/ai-gateway';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';

/**
 * PR 1 (Images) — ONE IMAGE ATTEMPT, LONG ENOUGH, NEVER REPEATED ON A TIMEOUT.
 *
 * Staging, 2026-11-04 07:17: an image request failed after 90,950 ms with
 * TIMEOUT. The route allowed 180 s, but each attempt was capped by the
 * provider's `timeoutMs` (30 s) and a TIMEOUT was retried twice. These tests
 * run the real gateway and ledger against the deterministic provider:
 *
 *   - an image attempt is given 180 s by default, whatever the provider's
 *     limit; a task rule's `attemptTimeoutMs` overrides it;
 *   - an image TIMEOUT runs ONE attempt — no retry, no fallback model — and
 *     charges nothing;
 *   - text keeps the provider's limit and its retries.
 */

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

const IMAGE_MODEL = 'mock-image';
const IMAGE_FALLBACK = 'mock-image-2';
const TEXT_MODEL = 'mock-fast';
const NO_LIMITS = {
  creditsPerDayMilli: null,
  creditsPerMonthMilli: null,
  maxConcurrentRequests: null,
};
const RETRY = { maxAttempts: 3, backoff: 'none' as const, initialDelayMs: 0, jitter: false };
const PARAMETERS = {
  temperature: 0.7,
  maxOutputTokens: 64,
  promptTemplateVersion: 1,
  persistOutput: false,
  outputRetentionDays: null,
};

let platform: PrismaClient;
let ledger: CreditLedgerService;
let mock: RecordingMock;
let gateway: AiGateway;
let attemptOverride: number | null = null;
const CREATED: string[] = [];

/** The deterministic provider, plus the limit each attempt was given. */
class RecordingMock extends MockProviderAdapter {
  readonly limits: number[] = [];
  override async generateImage(
    ...args: Parameters<MockProviderAdapter['generateImage']>
  ): ReturnType<MockProviderAdapter['generateImage']> {
    this.limits.push((args[1] as AdapterContext).timeoutMs);
    return super.generateImage(...args);
  }
  override async generateText(
    ...args: Parameters<MockProviderAdapter['generateText']>
  ): ReturnType<MockProviderAdapter['generateText']> {
    this.limits.push((args[1] as AdapterContext).timeoutMs);
    return super.generateText(...args);
  }
}

function model(key: string, modality: 'text' | 'image') {
  return {
    key,
    providerKey: 'mock',
    modality,
    qualityTier: 'balanced' as const,
    status: 'available' as const,
    disableSwitch: false,
  };
}

function configuration(): AiConfiguration {
  return {
    // The provider's own limit is 30 s, as staging's most likely is.
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
      model(IMAGE_MODEL, 'image'),
      model(IMAGE_FALLBACK, 'image'),
      model(TEXT_MODEL, 'text'),
    ],
    costBases: [],
    routingRules: [
      {
        taskKey: 'image.generate',
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: IMAGE_MODEL,
        fallbackModelKeys: [IMAGE_FALLBACK],
        timeoutMs: 600_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: { ...PARAMETERS, attemptTimeoutMs: attemptOverride },
        retryPolicy: RETRY,
        moderateInput: false,
        moderationModelKey: null,
      },
      {
        taskKey: 'caption.generate',
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: TEXT_MODEL,
        fallbackModelKeys: [],
        timeoutMs: 600_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: PARAMETERS,
        retryPolicy: RETRY,
        moderateInput: false,
        moderationModelKey: null,
      },
    ],
    creditRules: [
      {
        taskKey: 'image.generate',
        modelKey: IMAGE_MODEL,
        baseMilliCredits: 6_000,
        perUnitMilliCredits: 0,
        unit: 'image',
      },
      {
        taskKey: 'image.generate',
        modelKey: IMAGE_FALLBACK,
        baseMilliCredits: 6_000,
        perUnitMilliCredits: 0,
        unit: 'image',
      },
      {
        taskKey: 'caption.generate',
        modelKey: TEXT_MODEL,
        baseMilliCredits: 100,
        perUnitMilliCredits: 50,
        unit: '1k_tokens',
      },
    ],
    budgets: { defaults: NO_LIMITS, perPlan: [] },
  };
}

async function freshWorkspace(credits: number): Promise<string> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `pr1-${run}@example.local`,
      name: 'PR 1 Fixture',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  const workspace = await platform.workspace.create({
    data: {
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      id: run,
      workspaceId: run,
      slug: `pr1-${run.slice(0, 12)}`,
      name: 'PR 1 Fixture Workspace',
      ownerUserId: user.id,
      status: 'ACTIVE',
    } as never,
  });
  await platform.creditWallet.create({ data: { workspaceId: workspace.id } });
  CREATED.push(workspace.id);
  await ledger.grant({
    workspaceId: workspace.id,
    source: 'PLAN_GRANT',
    credits,
    reason: 'pr1 fixture allowance',
    idempotencyKey: `pr1-grant-${run}`,
  });
  return workspace.id;
}

function imageRequest(workspaceId: string): AiGatewayRequest {
  return {
    workspaceId,
    userId: null,
    taskKey: 'image.generate',
    planKey: null,
    idempotencyKey: `pr1-${crypto.randomUUID()}`,
    input: { kind: 'image', prompt: 'A van at sunrise.', count: 1, size: '1024x1024' },
  };
}

function textRequest(workspaceId: string): AiGatewayRequest {
  return {
    workspaceId,
    userId: null,
    taskKey: 'caption.generate',
    planKey: null,
    idempotencyKey: `pr1-${crypto.randomUUID()}`,
    input: { kind: 'text', prompt: 'Write a caption.' },
  };
}

const balanceOf = async (workspaceId: string) =>
  (await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } })).balanceMilliCredits;

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
  mock = new RecordingMock();
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters: new Map<string, AiProviderAdapter>([['mock', mock]]),
    configuration: { load: async () => configuration() },
    credentials: { resolve: async () => null },
    environment: 'DEVELOPMENT',
    random: () => 0.5,
  });
}, 90_000);

afterAll(async () => {
  if (platform && CREATED.length > 0) {
    await platform.aiRequest.deleteMany({
      where: { workspaceId: { in: CREATED }, status: { in: ['PENDING', 'RESERVED', 'RUNNING'] } },
    });
    await platform.creditReservation.deleteMany({ where: { workspaceId: { in: CREATED } } });
  }
  await platform?.$disconnect();
});

describe('PR 1 · the attempt policy', () => {
  it('an image attempt gets 180 s by default; text keeps the provider limit; a rule overrides', () => {
    expect(IMAGE_ATTEMPT_TIMEOUT_MS).toBe(180_000);
    expect(attemptTimeoutMsFor({ modality: 'image', parameters: {} }, 30_000)).toBe(180_000);
    expect(attemptTimeoutMsFor({ modality: 'text', parameters: {} }, 30_000)).toBe(30_000);
    expect(
      attemptTimeoutMsFor({ modality: 'image', parameters: { attemptTimeoutMs: 240_000 } }, 30_000),
    ).toBe(240_000);
    expect(
      attemptTimeoutMsFor({ modality: 'text', parameters: { attemptTimeoutMs: null } }, 45_000),
    ).toBe(45_000);
  });

  it('an image TIMEOUT is neither retried nor sent to the next model; text is', () => {
    expect(retriesAfter('TIMEOUT', 'image')).toBe(false);
    expect(fallsBackAfter('TIMEOUT', 'image')).toBe(false);
    expect(retriesAfter('TIMEOUT', 'text')).toBe(true);
    // Other transient image failures (nothing was made) keep their retry.
    expect(retriesAfter('PROVIDER_UNAVAILABLE', 'image')).toBe(true);
  });
});

describe('PR 1 · the gateway, end to end', () => {
  it('an image attempt is given 180 s although the provider says 30 s', async () => {
    mock.reset();
    mock.limits.length = 0;
    attemptOverride = null;
    const workspaceId = await freshWorkspace(50);
    const result = await gateway.execute(imageRequest(workspaceId));
    expect(result.status).toBe('SUCCEEDED');
    expect(mock.limits).toEqual([180_000]);
  });

  it('a configured attemptTimeoutMs is what the attempt gets', async () => {
    mock.reset();
    mock.limits.length = 0;
    attemptOverride = 240_000;
    const workspaceId = await freshWorkspace(50);
    await gateway.execute(imageRequest(workspaceId));
    expect(mock.limits).toEqual([240_000]);
    attemptOverride = null;
  });

  it('an image TIMEOUT: one attempt, no fallback, nothing charged', async () => {
    mock.reset();
    mock.limits.length = 0;
    const workspaceId = await freshWorkspace(50);
    const before = await balanceOf(workspaceId);
    mock.program({ failWith: 'TIMEOUT', times: 5 });

    const result = await gateway.execute(imageRequest(workspaceId));

    expect(result.status).toBe('TIMEOUT');
    expect(mock.calls.filter((call) => call.operation === 'generateImage')).toEqual([
      { modelKey: IMAGE_MODEL, operation: 'generateImage' },
    ]);
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    expect(row.retryCount).toBe(0);
    expect(row.attemptedModelKeys).toEqual([IMAGE_MODEL]);
    expect(await balanceOf(workspaceId)).toBe(before);
  });

  it('text keeps its retries on a TIMEOUT', async () => {
    mock.reset();
    mock.limits.length = 0;
    const workspaceId = await freshWorkspace(50);
    mock.program({ modelKey: TEXT_MODEL, failWith: 'TIMEOUT', times: 2 });
    const result = await gateway.execute(textRequest(workspaceId));
    expect(result.status).toBe('SUCCEEDED');
    expect(mock.calls.filter((call) => call.operation === 'generateText')).toHaveLength(3);
    expect(mock.limits).toEqual([30_000, 30_000, 30_000]);
  });
});
