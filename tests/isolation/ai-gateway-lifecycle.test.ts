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
 * The AI request lifecycle against a real PostgreSQL — docs/AI-GATEWAY.md §6.
 *
 * None of these guarantees can be shown without a database. They are properties
 * of a unique index, a CHECK constraint and a row lock, not of TypeScript:
 *
 *   - a failed request charges nothing (§7.4 guarantee 1)
 *   - a retry with the same key never charges twice and never calls the
 *     provider twice (guarantee 2)
 *   - no reservation is left open by any exit path (§6.1)
 *   - a request in one workspace is invisible and unreplayable from another
 *
 * The mock provider is used precisely because it can be TOLD to fail: a
 * failure path that cannot be summoned on demand is a failure path nobody has
 * tested.
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
const FALLBACK_KEY = 'mock-balanced';
const TASK_KEY = 'caption.generate';

/** The one phrase the fixture's moderation model refuses. */
const MODERATED_PHRASE = 'forbidden-sentinel';
const MODERATION_MODEL = 'mock-moderation';

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
    models: [
      {
        key: MODEL_KEY,
        providerKey: 'mock',
        modality: 'text',
        qualityTier: 'fast',
        status: 'available',
        disableSwitch: false,
      },
      {
        key: FALLBACK_KEY,
        providerKey: 'mock',
        modality: 'text',
        qualityTier: 'balanced',
        status: 'available',
        disableSwitch: false,
      },
      {
        key: MODERATION_MODEL,
        providerKey: 'mock',
        modality: 'moderation',
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
        fallbackModelKeys: [FALLBACK_KEY],
        timeoutMs: 5_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.7,
          maxOutputTokens: 64,
          promptTemplateVersion: 1,
          persistOutput: true,
          // Persisting requires a retention window — the approved
          // output-persistence policy refuses the two apart.
          outputRetentionDays: 30,
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
      {
        taskKey: TASK_KEY,
        modelKey: FALLBACK_KEY,
        baseMilliCredits: 100,
        perUnitMilliCredits: 50,
        unit: '1k_tokens',
      },
    ],
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
      email: `ai-${run}@example.local`,
      name: 'AI Fixture',
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
      slug: `ai-${run.slice(0, 12)}`,
      name: 'AI Fixture Workspace',
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
      reason: 'ai gateway fixture allowance',
      idempotencyKey: `ai-grant-${run}`,
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
    idempotencyKey: `req-${crypto.randomUUID()}`,
    input: { kind: 'text', prompt: 'Write a launch announcement for a coffee brand.' },
    ...overrides,
  };
}

async function walletOf(workspaceId: string): Promise<{ balance: bigint; reserved: bigint }> {
  const wallet = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
  return { balance: wallet.balanceMilliCredits, reserved: wallet.reservedMilliCredits };
}

async function openReservations(workspaceId: string): Promise<number> {
  return platform.creditReservation.count({ where: { workspaceId, status: 'OPEN' } });
}

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
  mock = new MockProviderAdapter({ flaggedPhrases: [MODERATED_PHRASE] });

  const adapters = new Map<string, AiProviderAdapter>([['mock', mock]]);
  gateway = new AiGateway({
    prisma: platform,
    ledger,
    adapters,
    configuration: { load: async () => activeConfiguration },
    credentials: { resolve: async () => null },
    environment: 'DEVELOPMENT',
  });
}, 90_000);

afterAll(async () => {
  // Only this run's reservations, for the reason credit-protocol.test.ts
  // documents: a bounded global sweep must not have to wade through residue.
  if (platform && CREATED_WORKSPACE_IDS.length > 0) {
    await platform.creditReservation.deleteMany({
      where: { workspaceId: { in: CREATED_WORKSPACE_IDS } },
    });
  }
  await platform?.$disconnect();
});

describe('a successful request', () => {
  it('reserves, settles on the actual, and leaves no reservation open', async () => {
    mock.reset();
    activeConfiguration = configuration();
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);

    const result = await gateway.execute(request(workspaceId));

    expect(result.status).toBe('SUCCEEDED');
    expect(result.modelKey).toBe(MODEL_KEY);
    expect(result.replayed).toBe(false);
    expect(result.creditsChargedMilli).toBeGreaterThan(0n);

    const after = await walletOf(workspaceId);
    // Charged the actual, not the estimate: the balance fell by exactly the
    // settled amount and nothing stayed held.
    expect(after.balance).toBe(before.balance - result.creditsChargedMilli);
    expect(after.reserved).toBe(0n);
    expect(await openReservations(workspaceId)).toBe(0);
  });

  it('settles for less than it reserved', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);

    const result = await gateway.execute(request(workspaceId));
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });

    // The reservation assumes the full maxOutputTokens; the mock returns fewer.
    // Reserving tightly is the dangerous direction — settling ABOVE a
    // reservation is refused by ai_request_charge_within_reservation.
    expect(row.creditsReservedMilli).toBeGreaterThan(row.creditsChargedMilli);
    expect(row.creditsChargedMilli).toBe(result.creditsChargedMilli);
  });

  it('writes one immutable ledger row carrying the cost basis', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);

    const result = await gateway.execute(request(workspaceId));
    const rows = await platform.aiUsageLedger.findMany({
      where: { aiRequestId: result.requestId },
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.modelKey).toBe(MODEL_KEY);
    expect(row?.creditsChargedMilli).toBe(result.creditsChargedMilli);
    // Sub-cent provider cost survives as a real number rather than rounding to
    // zero, which is the whole reason the column is micro-minor.
    expect(row?.providerCostMicroMinor).toBeGreaterThan(0n);
  });

  it('records usage and latency on the request row', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);

    const result = await gateway.execute(request(workspaceId));
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });

    expect(row.promptTokens).toBeGreaterThan(0);
    expect(row.completionTokens).toBeGreaterThan(0);
    expect(row.latencyMs).not.toBeNull();
    expect(row.completedAt).not.toBeNull();
  });

  it('stores no raw prompt content on the request row', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const secret = 'launch-announcement-for-a-coffee-brand-SENTINEL';

    const result = await gateway.execute(
      request(workspaceId, { input: { kind: 'text', prompt: secret } }),
    );
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });

    // §11: prompts are not persisted. `inputSummary` is metadata about the
    // prompt, never the prompt.
    expect(JSON.stringify(row.inputSummary)).not.toContain('SENTINEL');
  });
});

describe('a failed request charges nothing', () => {
  it('releases the reservation in full on a provider failure', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);
    mock.program({ failWith: 'PROVIDER_UNAVAILABLE', times: 10 });

    const result = await gateway.execute(request(workspaceId));

    expect(result.status).toBe('FAILED');
    expect(result.creditsChargedMilli).toBe(0n);

    const after = await walletOf(workspaceId);
    // §7.4 guarantee 1, stated as arithmetic: nothing moved at all.
    expect(after.balance).toBe(before.balance);
    expect(after.reserved).toBe(0n);
    expect(await openReservations(workspaceId)).toBe(0);
  });

  it('records a timeout as a timeout, with the reservation released', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);
    // Longer than the rule's 5s timeout. The gateway enforces the deadline
    // itself: a provider that ignores its own timeout must not be able to hold
    // a reservation open.
    mock.program({ delayMs: 60_000, times: 10 });

    const timed = configuration();
    activeConfiguration = {
      ...timed,
      routingRules: timed.routingRules.map((rule) => ({ ...rule, timeoutMs: 150 })),
    };

    const result = await gateway.execute(request(workspaceId));
    activeConfiguration = configuration();

    expect(result.status).toBe('TIMEOUT');
    expect(result.failureClass).toBe('TIMEOUT');
    expect((await walletOf(workspaceId)).balance).toBe(before.balance);
    expect(await openReservations(workspaceId)).toBe(0);
  });

  it('tells the customer nothing about the provider', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    mock.program({ failWith: 'AUTH_ERROR', times: 10 });

    const result = await gateway.execute(request(workspaceId));
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });

    // The class is recorded for the operator; the message the customer sees
    // says nothing about a key, an endpoint or a provider.
    expect(row.failureClass).toBe('AUTH_ERROR');
    expect(row.failureMessage).not.toMatch(/api[ _-]?key|sk-|auth_error|mock/i);
  });

  it('refuses a request the wallet cannot cover, without calling the provider', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(0);

    await expect(gateway.execute(request(workspaceId))).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
    });

    // Reserve-before-execute: a request that cannot be paid for never reaches
    // a provider, so it cannot cost us money either.
    expect(mock.calls).toHaveLength(0);
    expect(await openReservations(workspaceId)).toBe(0);
  });
});

describe('idempotency', () => {
  it('replays a completed request without charging or calling again', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const input = request(workspaceId);

    const first = await gateway.execute(input);
    const afterFirst = await walletOf(workspaceId);
    const callsAfterFirst = mock.calls.length;

    const second = await gateway.execute(input);

    expect(second.requestId).toBe(first.requestId);
    expect(second.replayed).toBe(true);
    expect(second.creditsChargedMilli).toBe(first.creditsChargedMilli);
    // §7.4 guarantee 2: neither the wallet nor the provider is touched again.
    expect(await walletOf(workspaceId)).toEqual(afterFirst);
    expect(mock.calls).toHaveLength(callsAfterFirst);
  });

  it('returns the original output on a replay when the rule persists it', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const input = request(workspaceId);

    const first = await gateway.execute(input);
    const second = await gateway.execute(input);

    // A client that lost the response gets the answer back rather than being
    // charged for one it will never see.
    expect(first.output).not.toBeNull();
    expect(second.output).toEqual(first.output);
  });

  it('persists no output when the rule does not opt in', async () => {
    mock.reset();
    const base = configuration();
    activeConfiguration = {
      ...base,
      routingRules: base.routingRules.map((rule) => ({
        ...rule,
        parameters: { ...rule.parameters, persistOutput: false },
      })),
    };
    const workspaceId = await freshWorkspace(50);

    const result = await gateway.execute(request(workspaceId));
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    activeConfiguration = configuration();

    // §11's default: generated content stays out of the database unless an
    // operator deliberately turned storage on.
    expect(row.outputPayload).toBeNull();
    // The caller still gets this run's output — it just was not written down.
    expect(result.output).not.toBeNull();
  });

  it('replays a FAILED request rather than retrying it silently', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    mock.program({ failWith: 'INVALID_REQUEST', times: 10 });
    const input = request(workspaceId);

    const first = await gateway.execute(input);
    mock.reset();
    const second = await gateway.execute(input);

    // Reusing a key for a different attempt would make "retry" mean two
    // different things depending on whether the first one failed.
    expect(second.requestId).toBe(first.requestId);
    expect(second.status).toBe('FAILED');
    expect(mock.calls).toHaveLength(0);
  });

  it('calls the provider exactly once when two callers race one key', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const input = request(workspaceId);
    const before = await walletOf(workspaceId);

    // Real concurrency. Awaiting these in sequence would prove nothing about
    // the unique index that actually stops the second one.
    const outcomes = await Promise.allSettled([
      gateway.execute(input),
      gateway.execute(input),
      gateway.execute(input),
    ]);

    const succeeded = outcomes.filter(
      (o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof gateway.execute>>> =>
        o.status === 'fulfilled',
    );
    // Losers either replay the winner's outcome or are told it is still
    // running. Neither may start a second reservation.
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const generateCalls = mock.calls.filter((call) => call.operation === 'generateText');
    expect(generateCalls).toHaveLength(1);

    const rows = await platform.aiRequest.findMany({ where: { workspaceId } });
    expect(rows).toHaveLength(1);

    const after = await walletOf(workspaceId);
    expect(after.reserved).toBe(0n);
    expect(before.balance - after.balance).toBe(rows[0]?.creditsChargedMilli);
  });
});

describe('concurrency against a finite wallet', () => {
  it('lets exactly as many through as the wallet can cover, and no more', async () => {
    mock.reset();
    activeConfiguration = configuration();

    /*
     * The §15 concurrency row: N parallel requests against a wallet with
     * capacity for fewer than N.
     *
     * Run in PARALLEL, not in sequence. Sequentially every request would see a
     * settled balance and the test would prove nothing about the row lock; in
     * parallel each one sees the others' reservations, which is the only way
     * the "no negative balance" guarantee is actually exercised.
     */
    // One credit is 1,000 milli-credits; each of these reserves a little over
    // 100, so twelve cannot all fit and some must be refused.
    const workspaceId = await freshWorkspace(1);
    const before = await walletOf(workspaceId);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () => gateway.execute(request(workspaceId))),
    );

    const succeeded = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter(
      (o) => o.status === 'rejected' && o.reason?.code === 'INSUFFICIENT_CREDITS',
    );

    // Every outcome is one or the other: nothing failed for an unexpected
    // reason, which is what a bad interleaving would look like.
    expect(succeeded.length + refused.length).toBe(12);
    expect(succeeded.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);

    const after = await walletOf(workspaceId);
    expect(after.balance).toBeGreaterThanOrEqual(0n);
    expect(after.reserved).toBe(0n);

    // The balance fell by exactly what was charged, no more and no less.
    const charged = await platform.aiRequest.aggregate({
      where: { workspaceId, status: 'SUCCEEDED' },
      _sum: { creditsChargedMilli: true },
    });
    expect(before.balance - after.balance).toBe(charged._sum.creditsChargedMilli ?? 0n);
  });

  it('reproduces the wallet balance by replaying the ledger', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(20);

    await gateway.execute(request(workspaceId));
    await gateway.execute(request(workspaceId));
    mock.program({ failWith: 'PROVIDER_UNAVAILABLE', times: 10 });
    await gateway.execute(request(workspaceId));
    mock.reset();

    // §15's ledger-integrity row, through the AI path: the balance is DERIVED
    // from the transaction log, never mutated in place (CLAUDE.md §2.4). A
    // failed request must leave no charge behind for this to hold.
    const transactions = await platform.creditTransaction.findMany({
      where: { workspaceId },
      orderBy: { occurredAt: 'asc' },
    });
    const replayed = transactions.reduce((sum, row) => sum + row.amountMilliCredits, 0n);

    expect(replayed).toBe((await walletOf(workspaceId)).balance);
  });
});

describe('the model kill switch, mid-session', () => {
  it('stops routing to a model the moment the registry disables it', async () => {
    mock.reset();
    activeConfiguration = configuration();
    const workspaceId = await freshWorkspace(50);

    const first = await gateway.execute(request(workspaceId));
    expect(first.modelKey).toBe(MODEL_KEY);

    // The registry changes; the ROUTING version does not. Config validation
    // refuses a rule pointing at a disabled model, but that check ran when the
    // routing version was activated — so a model killed afterwards is only
    // stopped if the resolver looks again at request time.
    const base = configuration();
    activeConfiguration = {
      ...base,
      models: base.models.map((model) =>
        model.key === MODEL_KEY ? { ...model, disableSwitch: true } : model,
      ),
    };

    const second = await gateway.execute(request(workspaceId));
    activeConfiguration = configuration();

    expect(second.modelKey).toBe(FALLBACK_KEY);
    expect(second.status).toBe('SUCCEEDED');
  });

  it('fails the request when the kill switch empties the whole chain', async () => {
    mock.reset();
    const base = configuration();
    activeConfiguration = {
      ...base,
      models: base.models.map((model) => ({ ...model, disableSwitch: true })),
    };
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);

    await expect(gateway.execute(request(workspaceId))).rejects.toMatchObject({
      name: 'RoutingError',
    });
    activeConfiguration = configuration();

    // Substituting some other available model would be the silent guess §5.3
    // forbids, and would spend credits on a model nobody chose.
    expect(await walletOf(workspaceId)).toEqual(before);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  it('refuses a cross-workspace replay as a plain not-found', async () => {
    mock.reset();
    const owner = await freshWorkspace(50);
    const stranger = await freshWorkspace(50);
    const input = request(owner);

    await gateway.execute(input);

    // CLAUDE.md §2.1: "forbidden" would confirm the key exists in another
    // workspace. The refusal is shaped exactly like a genuine miss.
    await expect(gateway.execute({ ...input, workspaceId: stranger })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('charges the asking workspace and never the other one', async () => {
    mock.reset();
    const a = await freshWorkspace(50);
    const b = await freshWorkspace(50);
    const beforeB = await walletOf(b);

    await gateway.execute(request(a));

    expect(await walletOf(b)).toEqual(beforeB);
    expect(await platform.aiUsageLedger.count({ where: { workspaceId: b } })).toBe(0);
  });
});

describe('input moderation', () => {
  function moderated(): AiConfiguration {
    const base = configuration();
    return {
      ...base,
      routingRules: base.routingRules.map((rule) => ({
        ...rule,
        moderateInput: true,
        moderationModelKey: MODERATION_MODEL,
      })),
    };
  }

  it('blocks flagged input and charges nothing for it', async () => {
    mock.reset();
    activeConfiguration = moderated();
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);

    const result = await gateway.execute(
      request(workspaceId, {
        input: { kind: 'text', prompt: `please write about ${MODERATED_PHRASE} today` },
      }),
    );
    activeConfiguration = configuration();

    // §10.7: a blocked result is not charged, and the reservation is released.
    expect(result.status).toBe('MODERATION_BLOCKED');
    expect(result.creditsChargedMilli).toBe(0n);
    expect(await walletOf(workspaceId)).toEqual(before);
    expect(await openReservations(workspaceId)).toBe(0);
  });

  it('never sends flagged input to the generating model', async () => {
    mock.reset();
    activeConfiguration = moderated();
    const workspaceId = await freshWorkspace(50);

    await gateway.execute(
      request(workspaceId, {
        input: { kind: 'text', prompt: `about ${MODERATED_PHRASE}` },
      }),
    );
    activeConfiguration = configuration();

    // The whole point of moderating BEFORE the provider call.
    expect(mock.calls.filter((call) => call.operation === 'generateText')).toHaveLength(0);
    expect(mock.calls.filter((call) => call.operation === 'moderate')).toHaveLength(1);
  });

  it('records no customer content on a blocked request', async () => {
    mock.reset();
    activeConfiguration = moderated();
    const workspaceId = await freshWorkspace(50);

    const result = await gateway.execute(
      request(workspaceId, {
        input: { kind: 'text', prompt: `about ${MODERATED_PHRASE} SECRETSENTINEL` },
      }),
    );
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    activeConfiguration = configuration();

    // Being refused is not a reason to start storing what was refused.
    expect(JSON.stringify(row.inputSummary)).not.toContain('SECRETSENTINEL');
    expect(row.failureMessage).not.toContain('SECRETSENTINEL');
  });

  it('lets clean input through', async () => {
    mock.reset();
    activeConfiguration = moderated();
    const workspaceId = await freshWorkspace(50);

    const result = await gateway.execute(request(workspaceId));
    activeConfiguration = configuration();

    expect(result.status).toBe('SUCCEEDED');
  });

  it('fails open when the moderation model itself is unavailable', async () => {
    mock.reset();
    activeConfiguration = moderated();
    const workspaceId = await freshWorkspace(50);
    mock.program({ modelKey: MODERATION_MODEL, failWith: 'PROVIDER_UNAVAILABLE', times: 10 });

    const result = await gateway.execute(request(workspaceId));
    activeConfiguration = configuration();

    /*
     * DELIBERATE, AND THE ONLY PLACE IN THE GATEWAY WHERE AN ERROR IS NOT
     * FATAL. A moderation outage that blocked every customer's work would be a
     * far larger incident than the content it exists to catch, and the outage
     * is visible through the same failure metrics as any other provider call.
     * A moderation model that ANSWERS and says "flagged" always blocks.
     */
    expect(result.status).toBe('SUCCEEDED');
  });

  it('does not moderate when the rule does not ask for it', async () => {
    mock.reset();
    activeConfiguration = configuration();
    const workspaceId = await freshWorkspace(50);

    const result = await gateway.execute(
      request(workspaceId, {
        input: { kind: 'text', prompt: `about ${MODERATED_PHRASE}` },
      }),
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(mock.calls.filter((call) => call.operation === 'moderate')).toHaveLength(0);
  });
});

describe('persisted output is deleted on a retention window', () => {
  /** The routing config with a retention window this test controls. */
  function retaining(days: number): AiConfiguration {
    const base = configuration();
    return {
      ...base,
      routingRules: base.routingRules.map((rule) => ({
        ...rule,
        parameters: { ...rule.parameters, persistOutput: true, outputRetentionDays: days },
      })),
    };
  }

  it('clears the payload once it is past its window, and keeps the accounting', async () => {
    mock.reset();
    activeConfiguration = retaining(30);
    const workspaceId = await freshWorkspace(50);

    const result = await gateway.execute(request(workspaceId));
    const before = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    expect(before.outputPayload).not.toBeNull();

    // Age it past the window. `completedAt` is the anchor the purge reads.
    await platform.aiRequest.update({
      where: { id: result.requestId },
      data: { completedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });

    const purged = await gateway.purgeExpiredOutputs();
    activeConfiguration = configuration();

    expect(purged).toBeGreaterThanOrEqual(1);
    const after = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });

    // The customer's content is gone...
    expect(after.outputPayload).toBeNull();
    // ...and the operational metadata the policy requires be RETAINED is not:
    // usage, cost, credits, idempotency and status all survive.
    expect(after.creditsChargedMilli).toBe(before.creditsChargedMilli);
    expect(after.providerCostMicroMinor).toBe(before.providerCostMicroMinor);
    expect(after.promptTokens).toBe(before.promptTokens);
    expect(after.idempotencyKey).toBe(before.idempotencyKey);
    expect(after.status).toBe('SUCCEEDED');
    expect(await platform.aiUsageLedger.count({ where: { aiRequestId: result.requestId } })).toBe(
      1,
    );
  });

  it('leaves output that is still inside its window', async () => {
    mock.reset();
    activeConfiguration = retaining(30);
    const workspaceId = await freshWorkspace(50);

    const result = await gateway.execute(request(workspaceId));
    await gateway.purgeExpiredOutputs();
    activeConfiguration = configuration();

    // Deleting early would break the replay guarantee the persistence exists
    // to serve.
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    expect(row.outputPayload).not.toBeNull();
  });

  it('still replays the accounting after the content has been purged', async () => {
    mock.reset();
    activeConfiguration = retaining(30);
    const workspaceId = await freshWorkspace(50);
    const input = request(workspaceId);

    const first = await gateway.execute(input);
    await platform.aiRequest.update({
      where: { id: first.requestId },
      data: { completedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    });
    await gateway.purgeExpiredOutputs();

    const replay = await gateway.execute(input);
    activeConfiguration = configuration();

    // The correct trade: the content is gone, the financial record is not, and
    // the replay still charges nothing a second time.
    expect(replay.replayed).toBe(true);
    expect(replay.output).toBeNull();
    expect(replay.creditsChargedMilli).toBe(first.creditsChargedMilli);
  });

  it('purges nothing when no rule retains anything', async () => {
    mock.reset();
    activeConfiguration = configuration();
    const workspaceId = await freshWorkspace(50);
    await gateway.execute(request(workspaceId));

    // The fixture's default rule persists output with no window configured, so
    // there is nothing for the purge to act on and it must not guess one.
    const base = configuration();
    activeConfiguration = {
      ...base,
      routingRules: base.routingRules.map((rule) => ({
        ...rule,
        parameters: { ...rule.parameters, outputRetentionDays: null },
      })),
    };
    expect(await gateway.purgeExpiredOutputs()).toBe(0);
    activeConfiguration = configuration();
  });
});

describe('budgets bind before the wallet and the provider', () => {
  it('refuses a request that would pass the daily credit ceiling', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const base = configuration();
    activeConfiguration = {
      ...base,
      // One milli-credit a day: everything real is over it.
      budgets: { defaults: { ...NO_LIMITS, creditsPerDayMilli: 1 }, perPlan: [] },
    };
    const before = await walletOf(workspaceId);

    await expect(gateway.execute(request(workspaceId))).rejects.toMatchObject({
      name: 'BudgetExceededError',
      code: 'QUOTA_EXCEEDED',
    });
    activeConfiguration = configuration();

    // A budget enforced after the fact is an invoice. Nothing was reserved,
    // nothing was called, and no request row exists to explain away.
    expect(await walletOf(workspaceId)).toEqual(before);
    expect(mock.calls).toHaveLength(0);
    expect(await platform.aiRequest.count({ where: { workspaceId } })).toBe(0);
  });

  it('counts only this workspace’s spend towards its ceiling', async () => {
    mock.reset();
    const spender = await freshWorkspace(50);
    const neighbour = await freshWorkspace(50);
    activeConfiguration = configuration();

    const spent = await gateway.execute(request(spender));
    expect(spent.status).toBe('SUCCEEDED');
    const spentRow = await platform.aiRequest.findUniqueOrThrow({
      where: { id: spent.requestId },
    });

    /*
     * The ceiling is set to EXACTLY one request's estimate.
     *
     * A workspace with nothing spent fits inside it; a workspace that has
     * already been charged does not. That makes the two outcomes below
     * decide the same question from opposite sides: does one tenant's usage
     * count against another's budget?
     */
    const base = configuration();
    activeConfiguration = {
      ...base,
      budgets: {
        defaults: { ...NO_LIMITS, creditsPerDayMilli: Number(spentRow.creditsReservedMilli) },
        perPlan: [],
      },
    };

    const neighbourResult = await gateway.execute(request(neighbour));
    expect(neighbourResult.status).toBe('SUCCEEDED');

    await expect(gateway.execute(request(spender))).rejects.toMatchObject({
      name: 'BudgetExceededError',
    });
    activeConfiguration = configuration();
  });

  it('refuses with retry guidance when too many requests are already running', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);

    // A request that never finishes, holding the one concurrency slot.
    const reservation = await ledger.reserve({
      workspaceId,
      estimateMilliCredits: 100n,
      purpose: TASK_KEY,
      idempotencyKey: `busy-${crypto.randomUUID()}`,
    });
    await platform.aiRequest.create({
      data: {
        workspaceId,
        taskKey: TASK_KEY,
        idempotencyKey: `busy-${crypto.randomUUID()}`,
        status: 'RUNNING',
        creditReservationId: reservation.id,
        creditsReservedMilli: 100n,
        deadlineAt: new Date(Date.now() + 600_000),
      },
    });

    const base = configuration();
    activeConfiguration = {
      ...base,
      budgets: { defaults: { ...NO_LIMITS, maxConcurrentRequests: 1 }, perPlan: [] },
    };

    // 429, not 402: waiting genuinely helps here, so the caller is told so.
    await expect(gateway.execute(request(workspaceId))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    activeConfiguration = configuration();

    await ledger.release(reservation.id, 'test cleanup');
  });

  it('applies a plan ceiling in place of the default', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const base = configuration();
    activeConfiguration = {
      ...base,
      budgets: {
        defaults: { ...NO_LIMITS, creditsPerDayMilli: 1 },
        perPlan: [
          {
            planKey: 'growth',
            creditsPerDayMilli: 1_000_000,
            creditsPerMonthMilli: null,
            maxConcurrentRequests: null,
          },
        ],
      },
    };

    // The same request the default would refuse succeeds on the plan that
    // raised the ceiling.
    const result = await gateway.execute(request(workspaceId, { planKey: 'growth' }));
    activeConfiguration = configuration();
    expect(result.status).toBe('SUCCEEDED');
  });

  it('refuses a request that costs more than the per-request ceiling', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);
    const base = configuration();
    activeConfiguration = {
      ...base,
      // Zero cost allowed: the task is switched off by cost.
      routingRules: base.routingRules.map((rule) => ({
        ...rule,
        fallbackModelKeys: [],
        maxCostPerRequestMinor: 0,
      })),
    };

    await expect(gateway.execute(request(workspaceId))).rejects.toMatchObject({
      name: 'BudgetExceededError',
    });
    activeConfiguration = configuration();

    expect(await walletOf(workspaceId)).toEqual(before);
    expect(mock.calls).toHaveLength(0);
  });

  it('drops an over-cap model and uses the operator’s next choice', async () => {
    mock.reset();
    const workspaceId = await freshWorkspace(50);
    const base = configuration();
    activeConfiguration = {
      ...base,
      // Only the primary has a cost basis, so only the primary can breach a
      // cost ceiling; the fallback stays affordable.
      routingRules: base.routingRules.map((rule) => ({ ...rule, maxCostPerRequestMinor: 0 })),
    };

    const result = await gateway.execute(request(workspaceId));
    activeConfiguration = configuration();

    // Treated like a disabled model, not like a failed request: the operator's
    // next choice may well be affordable.
    expect(result.status).toBe('SUCCEEDED');
    expect(result.modelKey).toBe(FALLBACK_KEY);
  });

  it('does not refuse anything when no budget is configured', async () => {
    mock.reset();
    activeConfiguration = configuration();
    const workspaceId = await freshWorkspace(50);

    const result = await gateway.execute(request(workspaceId));
    expect(result.status).toBe('SUCCEEDED');
  });
});

describe('configuration refusals happen before any charge', () => {
  it('fails a task with no routing rule without touching the wallet', async () => {
    mock.reset();
    const base = configuration();
    activeConfiguration = { ...base, routingRules: [] };
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);

    await expect(gateway.execute(request(workspaceId))).rejects.toMatchObject({
      name: 'RoutingError',
    });
    activeConfiguration = configuration();

    expect(await walletOf(workspaceId)).toEqual(before);
    expect(mock.calls).toHaveLength(0);
    expect(await platform.aiRequest.count({ where: { workspaceId } })).toBe(0);
  });

  it('fails a task nobody priced without touching the wallet', async () => {
    mock.reset();
    const base = configuration();
    activeConfiguration = { ...base, creditRules: [] };
    const workspaceId = await freshWorkspace(50);
    const before = await walletOf(workspaceId);

    await expect(gateway.execute(request(workspaceId))).rejects.toMatchObject({
      name: 'PricingError',
    });
    activeConfiguration = configuration();

    // Serving an unpriced task would serve it for free, permanently.
    expect(await walletOf(workspaceId)).toEqual(before);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects a request with no idempotency key', async () => {
    const workspaceId = await freshWorkspace(50);
    await expect(
      gateway.execute(request(workspaceId, { idempotencyKey: '   ' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
