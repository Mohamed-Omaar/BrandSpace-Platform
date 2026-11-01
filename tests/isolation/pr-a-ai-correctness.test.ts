import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AiGateway,
  OutputRejectedError,
  type AiConfiguration,
  type AiFailureClass,
  type AiGatewayRequest,
  type AiProviderAdapter,
  type TextRequest,
  type TextResult,
} from '@brandspace/ai-gateway';
import { CreditLedgerService, type CreditPolicy } from '@brandspace/entitlements';
import { defaultPayload } from '@brandspace/config';
import { withWorkspace } from '@brandspace/database';
import { BrandBrainChatService, BrandKnowledgeService } from '@brandspace/brand-brain';
import {
  CopilotOrchestrator,
  parseCopilotPolicy,
  resolveLiveAuthorization,
} from '@brandspace/copilot';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PR A — AI CORRECTNESS, ON REAL POSTGRESQL (check-up 2026-10-28 H-3, M-12, L-13
 * and item 6's operator detail).
 *
 * CI never calls a real provider: a scripted adapter answers each attempt with
 * the next scripted outcome. Every test asserts on the WALLET and the immutable
 * credit ledger, not only on the request row, because "not charged" is a
 * property of money.
 */

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

const MODEL = 'scripted-model';
const TASK = 'caption.generate';
// Assembled at runtime so the source holds no key-shaped literal (CI secret scan).
const FAKE_KEY = ['sk', 'proj', 'ABCDEFGHIJKLMNOPQRSTUV'].join('-');
const PROMPT = 'Write a launch announcement for the cardamom coffee range in Riyadh.';

type Step =
  | { readonly kind: 'text'; readonly text: string; readonly delayMs?: number }
  | {
      readonly kind: 'error';
      readonly failureClass: AiFailureClass;
      readonly providerCode?: string;
      readonly providerReason?: string;
    };

class ScriptedError extends Error {
  constructor(
    readonly failureClass: AiFailureClass,
    readonly providerCode?: string,
    readonly providerReason?: string,
  ) {
    super('scripted provider failure');
  }
}

class ScriptedAdapter implements AiProviderAdapter {
  readonly key = 'scripted';
  readonly supportedModalities = ['text'] as const;
  readonly script: Step[] = [];
  calls = 0;

  async testConnection() {
    return { ok: true, latencyMs: 0, message: 'ok' };
  }

  readonly prompts: string[] = [];

  async generateText(request: TextRequest): Promise<TextResult> {
    this.calls += 1;
    this.prompts.push(request.prompt);
    const step = this.script.shift() ?? { kind: 'text', text: '{"ok":true}' };
    if (step.kind === 'error') {
      throw new ScriptedError(step.failureClass, step.providerCode, step.providerReason);
    }
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    return {
      text: step.text,
      usage: { promptTokens: 40, completionTokens: 20 },
      modelKey: request.modelKey,
    };
  }

  classifyError(error: unknown): AiFailureClass {
    return error instanceof ScriptedError ? error.failureClass : 'UNKNOWN';
  }
}

function configuration(): AiConfiguration {
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
        key: MODEL,
        providerKey: 'scripted',
        modality: 'text',
        qualityTier: 'fast',
        status: 'available',
        disableSwitch: false,
      },
    ],
    costBases: [
      {
        modelKey: MODEL,
        inputCostPerUnitMicroMinor: 15_000,
        outputCostPerUnitMicroMinor: 60_000,
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
        primaryModelKey: MODEL,
        fallbackModelKeys: [],
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
        retryPolicy: { maxAttempts: 2, backoff: 'none', initialDelayMs: 0, jitter: false },
        moderateInput: false,
        moderationModelKey: null,
      },
      {
        taskKey: 'copilot.chat',
        scope: 'global',
        planKey: null,
        workspaceId: null,
        primaryModelKey: MODEL,
        fallbackModelKeys: [],
        timeoutMs: 5_000,
        maxCostPerRequestMinor: null,
        priority: 0,
        parameters: {
          temperature: 0.2,
          maxOutputTokens: 400,
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
        taskKey: TASK,
        modelKey: MODEL,
        baseMilliCredits: 1000,
        perUnitMilliCredits: 0,
        unit: 'request',
      },
      {
        taskKey: 'copilot.chat',
        modelKey: MODEL,
        baseMilliCredits: 1000,
        perUnitMilliCredits: 0,
        unit: 'request',
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

let platform: PrismaClient;
let ledger: CreditLedgerService;
let adapter: ScriptedAdapter;
let gateway: AiGateway;
/** Set by a test to make the success bookkeeping fail (L-13). */
let failBookkeeping = false;
const CREATED: string[] = [];

function gatewayWith(clockOffsetMs = 0): AiGateway {
  // The gateway's own client, wrapped so a test can make ITS `$transaction`
  // fail. The ledger keeps the real client: the wallet settle must succeed.
  const wrapped = new Proxy(platform, {
    get(target, property, receiver) {
      if (property === '$transaction' && failBookkeeping) {
        return () => Promise.reject(new Error('bookkeeping store unavailable'));
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return new AiGateway({
    prisma: wrapped,
    ledger,
    adapters: new Map<string, AiProviderAdapter>([['scripted', adapter]]),
    configuration: { load: async () => configuration() },
    credentials: { resolve: async () => null },
    environment: 'DEVELOPMENT',
    clock: { now: () => new Date(Date.now() + clockOffsetMs) },
  });
}

async function freshWorkspace(credits = 20): Promise<string> {
  const id = crypto.randomUUID();
  const user = await platform.user.create({
    data: { email: `pra-${id}@example.local`, name: 'PR A', status: 'ACTIVE', timezone: 'UTC' },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      country: 'SA',
      defaultLocale: 'AR',
      timezone: 'UTC',
      currency: 'USD',
      slug: `pra-${id.slice(0, 12)}`,
      name: 'PR A fixture',
      ownerUserId: user.id,
      status: 'ACTIVE',
    },
  });
  await platform.creditWallet.create({ data: { workspaceId: id } });
  await ledger.grant({
    workspaceId: id,
    source: 'PLAN_GRANT',
    credits,
    reason: 'PR A fixture allowance',
    idempotencyKey: `pra-grant-${id}`,
  });
  CREATED.push(id);
  return id;
}

function request(workspaceId: string, overrides: Partial<AiGatewayRequest> = {}): AiGatewayRequest {
  return {
    workspaceId,
    userId: null,
    taskKey: TASK,
    planKey: null,
    idempotencyKey: `pra-${crypto.randomUUID()}`,
    input: { kind: 'text', prompt: PROMPT },
    ...overrides,
  };
}

async function money(workspaceId: string) {
  const wallet = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
  const charges = await platform.creditTransaction.count({
    where: { workspaceId, type: 'USAGE_CHARGE' },
  });
  return { balance: wallet.balanceMilliCredits, reserved: wallet.reservedMilliCredits, charges };
}

const rejectNotJson = (output: { kind: string; text?: string }) => {
  if (output.kind !== 'text') throw new OutputRejectedError('not text');
  try {
    JSON.parse(output.text ?? '');
  } catch {
    throw new OutputRejectedError('The answer was not JSON.');
  }
};

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  ledger = new CreditLedgerService({ prisma: platform, policy: POLICY });
  adapter = new ScriptedAdapter();
  gateway = gatewayWith();
}, 90_000);

afterAll(async () => {
  if (platform && CREATED.length > 0) {
    await platform.creditReservation.deleteMany({ where: { workspaceId: { in: CREATED } } });
  }
  await platform?.$disconnect();
});

describe('H-3 — settle only after the output is validated', () => {
  it('an output the caller refuses is FAILED as OUTPUT_INVALID and charges nothing', async () => {
    const workspaceId = await freshWorkspace();
    const before = await money(workspaceId);
    adapter.script.push({ kind: 'text', text: 'Sure! Here is your caption: …' });

    const result = await gateway.execute(request(workspaceId, { accept: rejectNotJson }));

    expect(result.status).toBe('FAILED');
    expect(result.failureClass).toBe('OUTPUT_INVALID');
    expect(result.creditsChargedMilli).toBe(0n);
    expect(result.failureMessage).toContain('nothing was charged');
    const after = await money(workspaceId);
    expect(after.balance).toBe(before.balance);
    expect(after.reserved).toBe(0n);
    expect(after.charges).toBe(before.charges);
  });

  it('the same idempotency key RE-RUNS after a refused output, and charges once', async () => {
    const workspaceId = await freshWorkspace();
    const before = await money(workspaceId);
    const key = `pra-rerun-${crypto.randomUUID()}`;
    adapter.script.push({ kind: 'text', text: 'not json at all' });
    const first = await gateway.execute(
      request(workspaceId, { idempotencyKey: key, accept: rejectNotJson }),
    );
    expect(first.status).toBe('FAILED');

    adapter.script.push({ kind: 'text', text: '{"caption":"قهوة الهيل"}' });
    const second = await gateway.execute(
      request(workspaceId, { idempotencyKey: key, accept: rejectNotJson }),
    );
    expect(second.status).toBe('SUCCEEDED');
    expect(second.replayed).toBe(false);
    expect(second.output).toEqual({ kind: 'text', text: '{"caption":"قهوة الهيل"}' });

    const after = await money(workspaceId);
    expect(after.charges).toBe(before.charges + 1);
    expect(after.balance).toBe(before.balance - second.creditsChargedMilli);
    // The refused attempt is kept, renamed, as the record of what happened.
    const superseded = await platform.aiRequest.findFirst({
      where: { workspaceId, idempotencyKey: { startsWith: `${key}#superseded:` } },
    });
    expect(superseded?.failureClass).toBe('OUTPUT_INVALID');
  });

  it('a validator that throws something else is also a refusal, not a charge', async () => {
    const workspaceId = await freshWorkspace();
    const before = await money(workspaceId);
    adapter.script.push({ kind: 'text', text: '{"title":1}' });
    const result = await gateway.execute(
      request(workspaceId, {
        accept: () => {
          throw new TypeError('schema mismatch');
        },
      }),
    );
    expect(result.failureClass).toBe('OUTPUT_INVALID');
    expect((await money(workspaceId)).charges).toBe(before.charges);
  });
});

describe('M-12 — a truncated or empty answer is a failure', () => {
  it('OUTPUT_TRUNCATED charges nothing and is re-runnable', async () => {
    const workspaceId = await freshWorkspace();
    const before = await money(workspaceId);
    const key = `pra-trunc-${crypto.randomUUID()}`;
    adapter.script.push({
      kind: 'error',
      failureClass: 'OUTPUT_TRUNCATED',
      providerCode: 'finish_length',
    });
    const first = await gateway.execute(request(workspaceId, { idempotencyKey: key }));
    expect(first.failureClass).toBe('OUTPUT_TRUNCATED');
    expect(first.creditsChargedMilli).toBe(0n);
    expect((await money(workspaceId)).charges).toBe(before.charges);

    const second = await gateway.execute(request(workspaceId, { idempotencyKey: key }));
    expect(second.status).toBe('SUCCEEDED');
  });
});

describe('item 6 — the provider code and reason are for the operator only', () => {
  it('stores the code and a REDACTED reason, and the result object carries neither', async () => {
    const workspaceId = await freshWorkspace();
    adapter.script.push({
      kind: 'error',
      failureClass: 'INVALID_REQUEST',
      providerCode: 'invalid_size',
      providerReason: `Invalid value: '1080x1350'. Supported values are 1024x1024, 1536x1024. key ${FAKE_KEY}`,
    });
    const result = await gateway.execute(request(workspaceId));

    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    expect(row.providerErrorCode).toBe('invalid_size');
    expect(row.failureReason).toContain('Supported values are 1024x1024');
    expect(row.failureReason).not.toContain('sk-proj-');
    expect(row.failureReason).toContain('[REDACTED]');

    // (c) Never in a customer response: the gateway's result has no such field.
    expect(Object.keys(result)).not.toContain('providerErrorCode');
    expect(Object.keys(result)).not.toContain('failureReason');
    expect(
      JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain('invalid_size');
  });

  it('a provider message that quotes the prompt is withheld', async () => {
    const workspaceId = await freshWorkspace();
    adapter.script.push({
      kind: 'error',
      failureClass: 'INVALID_REQUEST',
      providerCode: 'bad_prompt',
      providerReason: `Could not process: "${PROMPT.slice(0, 40)}"`,
    });
    const result = await gateway.execute(request(workspaceId));
    const row = await platform.aiRequest.findUniqueOrThrow({ where: { id: result.requestId } });
    expect(row.failureReason).not.toContain('cardamom');
    expect(row.failureReason).toMatch(/withheld/);
  });

  it('the database refuses a failure detail on a request that succeeded', async () => {
    const workspaceId = await freshWorkspace();
    const ok = await gateway.execute(request(workspaceId));
    expect(ok.status).toBe('SUCCEEDED');
    await expect(
      platform.aiRequest.update({ where: { id: ok.requestId }, data: { failureReason: 'x' } }),
    ).rejects.toThrow();
  });
});

describe('L-13 — a settled charge is never recorded as an uncharged failure', () => {
  it('when the success bookkeeping fails, the sweep records the success that was charged', async () => {
    const workspaceId = await freshWorkspace();
    const before = await money(workspaceId);
    adapter.script.push({ kind: 'text', text: '{"ok":true}' });

    await expect(
      gateway.execute(
        request(workspaceId, {
          accept: () => {
            // Runs immediately before the settle: from here on, the gateway's
            // own transactions fail, the wallet's do not.
            failBookkeeping = true;
          },
        }),
      ),
    ).rejects.toThrow('bookkeeping store unavailable');
    failBookkeeping = false;

    const row = await platform.aiRequest.findFirstOrThrow({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.status).toBe('RUNNING');
    const charged = await money(workspaceId);
    expect(charged.charges).toBe(before.charges + 1);

    // An hour later the stuck-request sweep reconciles it.
    await gatewayWith(60 * 60_000).sweepStuckRequests(50);
    const swept = await platform.aiRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(swept.status).toBe('SUCCEEDED');
    expect(swept.creditsChargedMilli).toBe(before.balance - charged.balance);
    expect(swept.creditsChargedMilli).toBeGreaterThan(0n);
    // And nothing was charged twice or refunded.
    expect((await money(workspaceId)).charges).toBe(before.charges + 1);
  });
});

describe('KNOWN bug — the Copilot bad reply (ZodError, charged failed turn, 2026-10-28)', () => {
  let app: PrismaClient;
  let fixtures: IsolationFixtures;

  beforeAll(async () => {
    app = appRoleClient();
    fixtures = await createIsolationFixtures(app);
    await ledger.grant({
      workspaceId: fixtures.a.workspaceId,
      source: 'PLAN_GRANT',
      credits: 20,
      reason: 'PR A copilot fixture allowance',
      idempotencyKey: `pra-copilot-${fixtures.a.workspaceId}`,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.$disconnect();
  });

  const inA = <T>(fn: (db: never) => Promise<T>) =>
    withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

  const orchestratorIn = (db: never) =>
    new CopilotOrchestrator({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: parseCopilotPolicy(defaultPayload('copilot')),
      gateway,
    });

  async function turn(request: string) {
    const authorization = await inA((db) =>
      resolveLiveAuthorization(db, fixtures.a.workspaceId, fixtures.a.userId),
    );
    if (!authorization) throw new Error('fixture membership missing');
    const session = await inA((db) =>
      orchestratorIn(db).openSession({
        authorization,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
    return CopilotOrchestrator.turnWith((fn) => inA((db) => fn(orchestratorIn(db))), {
      sessionId: session.id,
      request,
      authorization,
      planKey: null,
      idempotencyKey: `pra-turn-${crypto.randomUUID()}`,
      expiresAt: null,
    });
  }

  const reply = (args: Record<string, unknown>, area: unknown = null) =>
    JSON.stringify({
      summary: { ar: 'مسودة', en: 'A draft' },
      steps: [{ toolKey: 'content.draft', arguments: args }],
      brandBrainQuestion: false,
      saveFact: area === null ? null : { area, title: 'Colours', body: 'Purple' },
    });

  it('the prompt states each tool’s arguments', async () => {
    adapter.script.push({
      kind: 'text',
      text: reply({ brief: 'Launch', platformKeys: ['instagram'] }),
    });
    await turn('Draft a launch post');
    const prompt = adapter.prompts.at(-1) ?? '';
    expect(prompt).toMatch(
      /content\.draft \([A-Za-z_]+.*\) arguments: \{brandId: uuid, brief: string/,
    );
  });

  it('a reply that fails a tool schema is repaired ONCE, and only the good reply is charged', async () => {
    const before = await money(fixtures.a.workspaceId);
    const calls = adapter.calls;
    // The 08:13 shape: the model left out required arguments.
    adapter.script.push({ kind: 'text', text: reply({ question: undefined }) });
    adapter.script.push({
      kind: 'text',
      text: reply({ brief: 'Launch week', platformKeys: ['instagram'] }),
    });

    const result = await turn('Draft a launch post');

    expect(adapter.calls).toBe(calls + 2);
    // The repair names the tool and the paths, never the model's own text.
    const repair = adapter.prompts.at(-1) ?? '';
    expect(repair).toContain('content.draft: brief, platformKeys');
    // brandId was the SESSION's brand, filled in rather than refused.
    expect(result.steps[0]?.arguments['brandId']).toBe(fixtures.a.brandId);
    const after = await money(fixtures.a.workspaceId);
    expect(after.charges).toBe(before.charges + 1);
  });

  it('a reply that fails twice is refused with a clear message and charges nothing', async () => {
    const before = await money(fixtures.a.workspaceId);
    adapter.script.push({ kind: 'text', text: reply({}) });
    adapter.script.push({ kind: 'text', text: 'not even JSON' });

    await expect(turn('Draft a launch post')).rejects.toMatchObject({
      message: expect.stringContaining('nothing was charged'),
    });
    const after = await money(fixtures.a.workspaceId);
    expect(after.charges).toBe(before.charges);
    expect(after.balance).toBe(before.balance);
    // Relative: the shared fixture keeps one reservation of its own open.
    expect(after.reserved).toBe(before.reserved);
  });

  it('a save request with an area in the model’s own words falls back to no area, not a failure', async () => {
    adapter.script.push({
      kind: 'text',
      text: JSON.stringify({
        summary: { ar: 'سأضيفه', en: 'I will add it' },
        steps: [],
        brandBrainQuestion: false,
        saveFact: { area: 'Brand colours', title: 'Colours', body: 'Purple and yellow' },
      }),
    });
    const result = await turn('Remember our colours are purple and yellow');
    expect(result.saveFact?.area).toBeNull();
    expect(result.saveFact?.body).toBe('Purple and yellow');
  });
});

describe('H-4 — the provider call runs outside the tenant transaction', () => {
  let app: PrismaClient;
  let fixtures: IsolationFixtures;

  beforeAll(async () => {
    app = appRoleClient();
    fixtures = await createIsolationFixtures(app);
    await ledger.grant({
      workspaceId: fixtures.a.workspaceId,
      source: 'PLAN_GRANT',
      credits: 20,
      reason: 'PR A H-4 fixture allowance',
      idempotencyKey: `pra-h4-${fixtures.a.workspaceId}`,
    });
    await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }).createItem({
          brandId: fixtures.a.brandId,
          area: 'OFFERS',
          itemKey: 'offers.current',
          title: { en: 'Cold brew offer' },
          body: { en: 'Cold brew is two for one on Fridays.' },
          actor: { userId: fixtures.a.userId, permissionKeys: [], brandScope: [] },
          policy: { reviewIntervalDays: 90 },
        }),
      { prisma: app },
    );
  }, 120_000);

  afterAll(async () => {
    await app?.$disconnect();
  });

  it('a provider slower than the tenant transaction timeout still answers, is stored and charged once', async () => {
    const before = await money(fixtures.a.workspaceId);
    // The tenant transactions may live 1 s; the provider takes 1.5 s. Holding
    // the transaction across the call — the old shape — expires it (P2028).
    adapter.script.push({
      kind: 'text',
      text: JSON.stringify({ kind: 'answer', answer: 'Two for one on Fridays.' }),
      delayMs: 1_500,
    });
    const run = <T>(fn: (chat: BrandBrainChatService) => Promise<T>) =>
      withWorkspace(
        fixtures.a.workspaceId,
        (db) =>
          fn(
            new BrandBrainChatService({
              db,
              workspaceId: fixtures.a.workspaceId,
              gateway,
              policy: { retentionDays: 30, maxContextItems: 12, maxContextChars: 12_000 },
            }),
          ),
        { prisma: app, timeoutMs: 1_000 },
      );

    const turn = await BrandBrainChatService.sendWith(run, {
      brandId: fixtures.a.brandId,
      message: 'What is the cold brew offer?',
      idempotencyKey: `pra-h4-${crypto.randomUUID()}`,
      actorUserId: fixtures.a.userId,
      planKey: null,
      actorBrandScope: [],
    });

    expect(turn.assistantMessage.body).toBe('Two for one on Fridays.');
    const after = await money(fixtures.a.workspaceId);
    expect(after.charges).toBe(before.charges + 1);
  });
});
