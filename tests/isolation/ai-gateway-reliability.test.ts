import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AiGateway,
  MockProviderAdapter,
  type AiConfiguration,
  type AiGatewayRequest,
  type AiProviderAdapter,
} from '@brandspace/ai-gateway';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';

/**
 * Retries, fallback and the stuck-request sweep — docs/AI-GATEWAY.md §5.3, §9, §6.1.
 *
 * These paths are the ones that spend money when they are wrong, and none of
 * them can be exercised without a provider that fails ON DEMAND. Every failure
 * below is programmed, not waited for.
 *
 * The invariant each test really guards is the same one: however many attempts
 * and models a request burns through, the customer is charged once on the
 * attempt that succeeded, or not at all.
 */

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

const PRIMARY = 'mock-fast';
const FALLBACK = 'mock-balanced';
const LAST_RESORT = 'mock-premium';
const TASK_KEY = 'caption.generate';

const NO_LIMITS = {
  creditsPerDayMilli: null,
  creditsPerMonthMilli: null,
  maxConcurrentRequests: null,
};

let platform: PrismaClient;
let ledger: CreditLedgerService;
let mock: MockProviderAdapter;
let gateway: AiGateway;

const CREATED_WORKSPACE_IDS: string[] = [];

function model(key: string) {
  return {
    key,
    providerKey: 'mock',
    modality: 'text' as const,
    qualityTier: 'balanced' as const,
    status: 'available' as const,
    disableSwitch: false,
  };
}

function creditRule(modelKey: string, baseMilliCredits = 100) {
  return {
    taskKey: TASK_KEY,
    modelKey,
    baseMilliCredits,
    perUnitMilliCredits: 50,
    unit: '1k_tokens' as const,
  };
}

function configuration(overrides: Partial<AiConfiguration> = {}): AiConfiguration {
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
    models: [model(PRIMARY), model(FALLBACK), model(LAST_RESORT)],
    costBases: [
      {
        modelKey: PRIMARY,
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
        primaryModelKey: PRIMARY,
        fallbackModelKeys: [FALLBACK, LAST_RESORT],
        timeoutMs: 5_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.7,
          maxOutputTokens: 64,
          promptTemplateVersion: 1,
          persistOutput: false,
          outputRetentionDays: null,
        },
        // No delay and no jitter: these tests are about WHICH attempts happen,
        // not about how long a sleep took.
        retryPolicy: { maxAttempts: 3, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
    ],
    creditRules: [creditRule(PRIMARY), creditRule(FALLBACK), creditRule(LAST_RESORT)],
    // No ceilings unless a test sets one: an unset budget must never refuse.
    budgets: { defaults: NO_LIMITS, perPlan: [] },
    ...overrides,
  };
}

let activeConfiguration: AiConfiguration = configuration();

async function freshWorkspace(credits: number): Promise<string> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `rel-${run}@example.local`,
      name: 'Reliability Fixture',
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
      slug: `rel-${run.slice(0, 12)}`,
      name: 'Reliability Fixture Workspace',
      ownerUserId: user.id,
      status: 'ACTIVE',
    },
  });
  await platform.creditWallet.create({ data: { workspaceId: workspace.id } });
  CREATED_WORKSPACE_IDS.push(workspace.id);
  if (credits > 0) {
    await ledger.grant({
      workspaceId: workspace.id,
      source: 'PLAN_GRANT',
      credits,
      reason: 'reliability fixture allowance',
      idempotencyKey: `rel-grant-${run}`,
    });
  }
  return workspace.id;
}

function request(workspaceId: string, overrides: Partial<AiGatewayRequest> = {}): AiGatewayRequest {
  return {
    workspaceId,
    userId: null,
    taskKey: TASK_KEY,
    planKey: null,
    idempotencyKey: `rel-${crypto.randomUUID()}`,
    input: { kind: 'text', prompt: 'Write a launch announcement.' },
    ...overrides,
  };
}

async function walletOf(workspaceId: string): Promise<{ balance: bigint; reserved: bigint }> {
  const wallet = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
  return { balance: wallet.balanceMilliCredits, reserved: wallet.reservedMilliCredits };
}

function generateCalls(): string[] {
  return mock.calls.filter((call) => call.operation === 'generateText').map((c) => c.modelKey);
}

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
  mock = new MockProviderAdapter();

  const adapters = new Map<string, AiProviderAdapter>([['mock', mock]]);
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters,
    configuration: { load: async () => activeConfiguration },
    credentials: { resolve: async () => null },
    environment: 'DEVELOPMENT',
    // Jitter fixed, so a sleep length is never the reason a test fails.
    random: () => 0.5,
  });
}, 90_000);

afterAll(async () => {
  /*
   * This run's AI requests go FIRST, then its reservations.
   *
   * The sweep reads a bounded, globally ordered window of NON-TERMINAL
   * requests. Leaving this suite's rows behind would fill that window with
   * residue on the next run and starve the fresh rows behind it — F-53's shape
   * in a different table.
   *
   * Only non-terminal rows are removed, and deliberately so. A terminal row
   * has an immutable `ai_usage_ledger` entry behind it that the platform role
   * cannot delete and must not try to: that append-only guarantee is the
   * financial record, and a test suite is not an exception to it. Nothing
   * queries terminal requests under a bound, so they are left alone (F-61).
   */
  if (platform && CREATED_WORKSPACE_IDS.length > 0) {
    await platform.aiRequest.deleteMany({
      where: {
        workspaceId: { in: CREATED_WORKSPACE_IDS },
        status: { in: ['PENDING', 'RESERVED', 'RUNNING'] },
      },
    });
    await platform.creditReservation.deleteMany({
      where: { workspaceId: { in: CREATED_WORKSPACE_IDS } },
    });
  }
  await platform?.$disconnect();
});

describe('retrying the same model', () => {
  it('retries a transient failure and charges once for the attempt that worked', async () => {
    mock.reset();
    activeConfiguration = configuration();
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);
    mock.program({ modelKey: PRIMARY, failWith: 'PROVIDER_UNAVAILABLE', times: 2 });

    const result = await gateway.execute(request(workspaceId));

    expect(result.status).toBe('SUCCEEDED');
    expect(result.modelKey).toBe(PRIMARY);
    expect(generateCalls()).toEqual([PRIMARY, PRIMARY, PRIMARY]);

    const after = await walletOf(workspaceId);
    // Three provider calls, ONE charge. §7.4 guarantee 2 is about retries
    // inside the gateway as much as retries from a client.
    expect(before.balance - after.balance).toBe(result.creditsChargedMilli);
    expect(after.reserved).toBe(0n);
  });

  it('records how many retries it took', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    mock.program({ modelKey: PRIMARY, failWith: 'TIMEOUT', times: 1 });

    const result = await gateway.execute(request(workspaceId));
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });

    expect(row.retryCount).toBe(1);
    expect(row.attemptedModelKeys).toEqual([PRIMARY, PRIMARY]);
  });

  it('does not retry a deterministic rejection', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    mock.program({ failWith: 'INVALID_REQUEST', times: 10 });

    const result = await gateway.execute(request(workspaceId));

    // A second attempt would burn the customer's deadline to reach the same
    // answer, and a second model would fail identically.
    expect(result.status).toBe('FAILED');
    expect(generateCalls()).toEqual([PRIMARY]);
  });

  it('stops after maxAttempts rather than retrying forever', async () => {
    mock.reset();
    const base = configuration();
    activeConfiguration = {
      ...base,
      routingRules: base.routingRules.map((rule) => ({
        ...rule,
        fallbackModelKeys: [],
        retryPolicy: { ...rule.retryPolicy, maxAttempts: 2 },
      })),
    };
    const workspaceId = await freshWorkspace(50);
    mock.program({ failWith: 'RATE_LIMITED', times: 100 });

    const result = await gateway.execute(request(workspaceId));
    activeConfiguration = configuration();

    expect(result.status).toBe('FAILED');
    expect(generateCalls()).toHaveLength(2);
    expect(result.creditsChargedMilli).toBe(0n);
  });
});

describe('falling back to another model', () => {
  it('walks the chain in the operator’s order and succeeds on a later model', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);
    mock.program(
      { modelKey: PRIMARY, failWith: 'MODEL_UNAVAILABLE', times: 10 },
      { modelKey: FALLBACK, failWith: 'PROVIDER_UNAVAILABLE', times: 10 },
    );

    const result = await gateway.execute(request(workspaceId));

    expect(result.status).toBe('SUCCEEDED');
    expect(result.modelKey).toBe(LAST_RESORT);
    // MODEL_UNAVAILABLE is not retryable, so the primary is tried once;
    // PROVIDER_UNAVAILABLE is, so the fallback is tried three times.
    expect(generateCalls()).toEqual([PRIMARY, FALLBACK, FALLBACK, FALLBACK, LAST_RESORT]);

    const after = await walletOf(workspaceId);
    // Five provider calls, one charge — §5.3 point 5.
    expect(before.balance - after.balance).toBe(result.creditsChargedMilli);
  });

  it('records every model it tried, including the ones that failed', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    mock.program({ modelKey: PRIMARY, failWith: 'MODEL_UNAVAILABLE', times: 10 });

    const result = await gateway.execute(request(workspaceId));
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });

    // §5.3 point 4. Without this, a fallback is invisible in reporting and the
    // fallback-rate alert of §12 has nothing to measure.
    expect(row.attemptedModelKeys).toContain(PRIMARY);
    expect(row.resolvedModelKey).toBe(FALLBACK);
  });

  it('does not fall back on a content refusal', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    mock.program({ failWith: 'CONTENT_FILTERED', times: 10 });

    const result = await gateway.execute(request(workspaceId));

    // A different model that did NOT refuse would be routing around a
    // moderation decision instead of surfacing it.
    expect(result.status).toBe('FAILED');
    expect(result.failureClass).toBe('CONTENT_FILTERED');
    expect(generateCalls()).toEqual([PRIMARY]);
  });

  it('does not fall back on our own account failure', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    mock.program({ failWith: 'AUTH_ERROR', times: 10 });

    const result = await gateway.execute(request(workspaceId));

    // Serving these from a second provider would hide an outage the operator
    // has to see — and would bill it to a different provider account.
    expect(result.status).toBe('FAILED');
    expect(generateCalls()).toEqual([PRIMARY]);
  });

  it('charges nothing when the whole chain fails', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);
    mock.program({ failWith: 'PROVIDER_UNAVAILABLE', times: 100 });

    const result = await gateway.execute(request(workspaceId));

    expect(result.status).toBe('FAILED');
    expect(await walletOf(workspaceId)).toEqual(before);
    expect(await platform.creditReservation.count({ where: { workspaceId, status: 'OPEN' } })).toBe(
      0,
    );
  });

  it('reserves enough for the dearest model in the chain, not just the primary', async () => {
    mock.reset();
    const base = configuration();
    activeConfiguration = {
      ...base,
      // The fallback costs ten times the primary. Sizing the reservation on the
      // primary alone would make this settle ABOVE its reservation, which
      // ai_request_charge_within_reservation refuses — turning a successful
      // generation into a 500 after we already paid the provider.
      creditRules: [creditRule(PRIMARY, 100), creditRule(FALLBACK, 1000), creditRule(LAST_RESORT)],
    };
    const workspaceId = await freshWorkspace(50);
    mock.program({ modelKey: PRIMARY, failWith: 'MODEL_UNAVAILABLE', times: 10 });

    const result = await gateway.execute(request(workspaceId));
    activeConfiguration = configuration();

    expect(result.status).toBe('SUCCEEDED');
    expect(result.modelKey).toBe(FALLBACK);
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    expect(row.creditsChargedMilli).toBeGreaterThan(100n);
    expect(row.creditsReservedMilli).toBeGreaterThanOrEqual(row.creditsChargedMilli);
  });
});

describe('the deadline bounds the whole chain', () => {
  it('does not give each attempt a fresh timeout', async () => {
    mock.reset();
    const base = configuration();
    activeConfiguration = {
      ...base,
      routingRules: base.routingRules.map((rule) => ({ ...rule, timeoutMs: 250 })),
    };
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);
    // Each attempt would hang far past the deadline. With a per-attempt
    // timeout the reservation would be held for maxAttempts x timeoutMs.
    mock.program({ delayMs: 60_000, times: 100 });

    const startedAt = Date.now();
    const result = await gateway.execute(request(workspaceId));
    const elapsed = Date.now() - startedAt;
    activeConfiguration = configuration();

    expect(result.status).toBe('TIMEOUT');
    /*
     * ONE attempt, not nine.
     *
     * This is the timing-independent half of the assertion, and the one that
     * matters: the first attempt consumes the whole budget, so the deadline
     * check refuses to start a second. If each attempt got a fresh timeout the
     * chain would make 3 models x 3 attempts = 9 calls and hold the
     * reservation for nine times as long.
     */
    expect(generateCalls()).toHaveLength(1);
    // And the wall clock agrees: ~250ms of work, not ~2,250ms.
    expect(elapsed).toBeLessThan(1_500);
    expect(await walletOf(workspaceId)).toEqual(before);
  });

  it('gives a retry only the time the earlier attempt left behind', async () => {
    mock.reset();
    const base = configuration();
    activeConfiguration = {
      ...base,
      routingRules: base.routingRules.map((rule) => ({
        ...rule,
        fallbackModelKeys: [],
        timeoutMs: 1_000,
      })),
    };
    const workspaceId = await freshWorkspace(50);
    // The first attempt burns 700ms of the 1,000ms budget before failing with
    // a retryable class; the second hangs. A retry handed a FRESH 1,000ms
    // would run to 1,700ms and hold the reservation for most of a second
    // longer than the rule allows.
    mock.program({ delayMs: 700, failWith: 'RATE_LIMITED' }, { delayMs: 60_000, times: 10 });

    const startedAt = Date.now();
    const result = await gateway.execute(request(workspaceId));
    const elapsed = Date.now() - startedAt;
    activeConfiguration = configuration();

    expect(result.status).toBe('TIMEOUT');
    expect(generateCalls()).toHaveLength(2);
    expect(elapsed).toBeLessThan(1_400);
  });
});

describe('the stuck-request sweep', () => {
  /** A request abandoned mid-flight: RUNNING, past its deadline, still holding credits. */
  async function abandonRequest(workspaceId: string, deadlineAt: Date): Promise<string> {
    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 500n,
      purpose: TASK_KEY,
      idempotencyKey: `stuck-${crypto.randomUUID()}`,
    });
    const row = await platform.aiRequest.create({
      data: {
        workspaceId,
        taskKey: TASK_KEY,
        idempotencyKey: `stuck-${crypto.randomUUID()}`,
        resolvedModelKey: PRIMARY,
        attemptedModelKeys: [PRIMARY],
        status: 'RUNNING',
        creditsReservedMilli: 500n,
        creditReservationId: reservation.id,
        deadlineAt,
      },
    });
    return row.id;
  }

  it('releases the credits and marks the request timed out', async () => {
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);
    const requestId = await abandonRequest(workspaceId, new Date(Date.now() - 60_000));

    // Held right now: the whole reason the sweep exists.
    expect((await walletOf(workspaceId)).reserved).toBe(before.reserved + 500n);

    const result = await gateway.sweepStuckRequests(200);

    expect(result.swept).toBeGreaterThanOrEqual(1);
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe('TIMEOUT');
    expect(row.creditsChargedMilli).toBe(0n);
    // §6.1: no reservation outlives its request.
    expect(await walletOf(workspaceId)).toEqual(before);
  });

  it('leaves a request that is still within its deadline alone', async () => {
    const workspaceId = await freshWorkspace(50);
    const requestId = await abandonRequest(workspaceId, new Date(Date.now() + 600_000));

    await gateway.sweepStuckRequests(200);

    // Sweeping a live request would cancel work that is about to succeed and
    // release credits the settle is about to claim.
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe('RUNNING');
    expect((await walletOf(workspaceId)).reserved).toBe(500n);

    await ledger.release(row.creditReservationId ?? '', 'test cleanup');
  });

  it('reports honestly when it stops at its bound', async () => {
    const workspaceId = await freshWorkspace(200);
    for (let i = 0; i < 3; i += 1) {
      await abandonRequest(workspaceId, new Date(Date.now() - 120_000 - i));
    }

    // `swept` alone cannot tell "there is nothing left" from "the bound was
    // hit and there is more to do", and that difference is the whole point of
    // a leak metric that must stay at zero.
    const bounded = await gateway.sweepStuckRequests(1, { maxAttempts: 1 });
    expect(bounded.swept).toBe(1);
    expect(bounded.exhausted).toBe(false);

    const rest = await gateway.sweepStuckRequests(500);
    expect(rest.exhausted).toBe(true);
  });

  it('reconciles the oldest deadline first', async () => {
    const workspaceId = await freshWorkspace(200);
    const oldest = await abandonRequest(workspaceId, new Date(Date.now() - 900_000));
    const newer = await abandonRequest(workspaceId, new Date(Date.now() - 30_000));

    await gateway.sweepStuckRequests(1, { maxAttempts: 1 });

    // Deterministic ordering: the longest-held credits are freed first, and
    // two nodes sweeping the same backlog agree on what they are doing.
    const oldestRow = await platform.aiRequest.findUniqueOrThrow({ where: { id: oldest } });
    const newerRow = await platform.aiRequest.findUniqueOrThrow({ where: { id: newer } });

    // Other suites leave residue behind, so the assertion is relative: if MY
    // newer row was swept, my older one must have been too.
    if (newerRow.status === 'TIMEOUT') {
      expect(oldestRow.status).toBe('TIMEOUT');
    }

    await gateway.sweepStuckRequests(500);
  });
});
