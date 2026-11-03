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
  /** PR B — the fenced context each call carried (the summary travels there). */
  readonly contexts: string[] = [];

  async generateText(request: TextRequest): Promise<TextResult> {
    this.calls += 1;
    this.prompts.push(request.prompt);
    this.contexts.push((request.untrustedContext ?? []).join('\n'));
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
    // Every argument the MODEL writes is stated. `brandId` is not one of them
    // (PR A2): the platform sets it to the session's brand, and the prompt
    // says so — a model asked for an id it was never told invents one.
    expect(prompt).toMatch(/content\.draft \([A-Za-z_]+.*\) arguments: \{brief: string/);
    expect(prompt).not.toMatch(/arguments: \{[^\n]*brandId/);
    expect(prompt).toContain(
      'Never write "brandId": the platform sets it to this conversation\'s brand.',
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

/*
 * PR B (D-594) — ONE CONTINUOUS COPILOT CONVERSATION PER PERSON PER BRAND.
 * Here because this file already holds a scripted provider the prompts can be
 * read from; the migration that merges existing conversations has its own
 * suite (pr-b-one-assistant-migration).
 */
describe('PR B — the one conversation: memory, New topic, search, Clear', () => {
  let app: PrismaClient;
  let fixtures: IsolationFixtures;

  beforeAll(async () => {
    app = appRoleClient();
    fixtures = await createIsolationFixtures(app);
    await ledger.grant({
      workspaceId: fixtures.a.workspaceId,
      source: 'PLAN_GRANT',
      credits: 50,
      reason: 'PR B conversation fixture allowance',
      idempotencyKey: `prb-conversation-${fixtures.a.workspaceId}`,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.$disconnect();
  });

  const inWs = <T>(workspaceId: string, fn: (db: never) => Promise<T>) =>
    withWorkspace(workspaceId, fn as never, { prisma: app }) as Promise<T>;
  const inA = <T>(fn: (db: never) => Promise<T>) => inWs(fixtures.a.workspaceId, fn);
  const orchestratorIn = (db: never, workspaceId = fixtures.a.workspaceId) =>
    new CopilotOrchestrator({
      db,
      workspaceId,
      policy: parseCopilotPolicy(defaultPayload('copilot')),
      gateway,
    });
  const answer = (en: string) =>
    JSON.stringify({
      summary: { ar: en, en },
      steps: [],
      brandBrainQuestion: false,
      saveFact: null,
    });

  async function me() {
    const authorization = await inA((db) =>
      resolveLiveAuthorization(db, fixtures.a.workspaceId, fixtures.a.userId),
    );
    if (!authorization) throw new Error('fixture membership missing');
    return authorization;
  }
  async function open() {
    const authorization = await me();
    return inA((db) =>
      orchestratorIn(db).openSession({
        authorization,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
  }
  async function say(request: string, reply = 'Noted.') {
    adapter.script.push({ kind: 'text', text: answer(reply) });
    const session = await open();
    await CopilotOrchestrator.turnWith((fn) => inA((db) => fn(orchestratorIn(db))), {
      sessionId: session.id,
      request,
      authorization: await me(),
      planKey: null,
      idempotencyKey: `prb-${crypto.randomUUID()}`,
      expiresAt: null,
    });
    return adapter.prompts.at(-1) ?? '';
  }

  it('opening from any page returns the same conversation, on the page now shown', async () => {
    const first = await open();
    const authorization = await me();
    const again = await inA((db) =>
      orchestratorIn(db).openSession({
        authorization,
        brandId: fixtures.a.brandId,
        surface: 'content',
        locale: 'AR',
        expiresAt: null,
      }),
    );
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ surface: 'content', locale: 'AR', archivedAt: null });
  });

  it('memory: the next turn sees the previous one ("make it shorter" has its context)', async () => {
    await say(
      'Write a line about our autumn opening hours.',
      'We open at 9 every day this autumn.',
    );
    const prompt = await say('Make it shorter.');
    expect(prompt).toContain('Write a line about our autumn opening hours.');
    expect(prompt).toContain('We open at 9 every day this autumn.');
  });

  it('New topic: the model no longer reads what came before the divider, which stays visible', async () => {
    const session = await open();
    const authorization = await me();
    await say('Remember the word PINEAPPLE for later.');
    await inA((db) => orchestratorIn(db).newTopic({ authorization, sessionId: session.id }));
    const prompt = await say('What were we talking about?');
    expect(prompt).not.toContain('PINEAPPLE');
    const page = await inA((db) =>
      orchestratorIn(db).conversation({ authorization, sessionId: session.id }),
    );
    expect(page.messages.some((m) => m.body?.includes('PINEAPPLE'))).toBe(true);
    expect(page.messages.filter((m) => m.kind === 'topic_break')).toHaveLength(1);
  });

  it('search finds words inside the conversation', async () => {
    const session = await open();
    const authorization = await me();
    await say('The secret ingredient is cardamom.');
    const found = await inA((db) =>
      orchestratorIn(db).conversation({ authorization, sessionId: session.id, search: 'CARDAMOM' }),
    );
    expect(found.messages.length).toBeGreaterThan(0);
    expect(found.messages.every((m) => m.body?.toLowerCase().includes('cardamom'))).toBe(true);
  });

  it('older turns become the rolling summary, and the summary is in the prompt', async () => {
    const session = await open();
    const authorization = await me();
    await inA((db) => orchestratorIn(db).newTopic({ authorization, sessionId: session.id }));
    await say('Our founding year is 2019, keep it in mind.');
    for (let i = 0; i < 6; i += 1) await say(`Filler question number ${i}.`);
    const stored = await inA((db) =>
      (db as unknown as PrismaClient).copilotSession.findFirstOrThrow({
        where: { id: session.id },
        select: { summary: true, summaryThroughAt: true },
      }),
    );
    expect(stored.summary).toContain('Our founding year is 2019');
    await say('Which year did I mention?');
    // Fenced as reference material, like every block of customer text.
    const context = adapter.contexts.at(-1) ?? '';
    expect(context).toContain('EARLIER IN THIS CONVERSATION (summary)');
    expect(context).toContain('Our founding year is 2019');
  });

  it('another workspace cannot read, divide or clear this conversation (the same 404)', async () => {
    const session = await open();
    const theirs = await inWs(fixtures.b.workspaceId, (db) =>
      resolveLiveAuthorization(db, fixtures.b.workspaceId, fixtures.b.userId),
    );
    if (!theirs) throw new Error('fixture membership missing');
    const acts: ((o: CopilotOrchestrator) => Promise<unknown>)[] = [
      (o: CopilotOrchestrator) => o.conversation({ authorization: theirs, sessionId: session.id }),
      (o: CopilotOrchestrator) => o.newTopic({ authorization: theirs, sessionId: session.id }),
      (o: CopilotOrchestrator) =>
        o.clearConversation({ authorization: theirs, sessionId: session.id }),
    ];
    for (const act of acts) {
      await expect(
        inWs(fixtures.b.workspaceId, (db) => act(orchestratorIn(db, fixtures.b.workspaceId))),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('Clear conversation deletes the messages and the summary, and is audited', async () => {
    const session = await open();
    const authorization = await me();
    await say('Something to forget.');
    const result = await inA((db) =>
      orchestratorIn(db).clearConversation({ authorization, sessionId: session.id }),
    );
    expect(result.deleted).toBeGreaterThan(0);
    const page = await inA((db) =>
      orchestratorIn(db).conversation({ authorization, sessionId: session.id }),
    );
    expect(page.messages).toEqual([]);
    const stored = await platform.copilotSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { summary: true },
    });
    expect(stored.summary).toBeNull();
    const audit = await platform.auditEvent.findFirst({
      where: { action: 'copilot.conversation_cleared', resourceId: session.id },
      select: { after: true },
    });
    expect(audit?.after).toEqual({ messagesDeleted: result.deleted });
  });

  /** A turn whose scripted reply proposes `steps`, as `authorization`. */
  async function ask(
    request: string,
    reply: { en: string; ar?: string; steps?: { toolKey: string; arguments: object }[] },
    authorization?: Awaited<ReturnType<typeof me>>,
  ) {
    adapter.script.push({
      kind: 'text',
      text: JSON.stringify({
        summary: { ar: reply.ar ?? reply.en, en: reply.en },
        steps: reply.steps ?? [],
        brandBrainQuestion: false,
        saveFact: null,
      }),
    });
    const session = await open();
    const result = await CopilotOrchestrator.turnWith((fn) => inA((db) => fn(orchestratorIn(db))), {
      sessionId: session.id,
      request,
      authorization: authorization ?? (await me()),
      planKey: null,
      idempotencyKey: `prb-${crypto.randomUUID()}`,
      expiresAt: null,
    });
    return { result, session, prompt: adapter.prompts.at(-1) ?? '' };
  }

  it('an Arabic greeting is answered in Arabic, and kept in Arabic', async () => {
    const authorization = await me();
    const { session } = await ask('مرحبا! كيف حالك؟', { en: 'Hello!', ar: 'أهلًا بك!' });
    const page = await inA((db) =>
      orchestratorIn(db).conversation({ authorization, sessionId: session.id }),
    );
    const last = page.messages.at(-1);
    expect(last).toMatchObject({ role: 'ASSISTANT', body: 'أهلًا بك!' });
  });

  it('"how many credits" and "who is on my team" are answered from tools, never the model', async () => {
    const credits = await ask('How many credits do we have left?', {
      en: 'Let me check.',
      steps: [{ toolKey: 'credits.balance', arguments: {} }],
    });
    expect(credits.prompt).toMatch(/^- credits\.balance \(READ_ONLY\)/m);
    expect(credits.prompt).toContain('Every number in your answer must come from a tool result');
    expect(credits.result.steps).toEqual([{ toolKey: 'credits.balance', arguments: {} }]);
    const team = await ask('Who is on my team?', {
      en: 'Here is the team.',
      steps: [{ toolKey: 'team.list', arguments: {} }],
    });
    expect(team.result.steps.map((step) => step.toolKey)).toEqual(['team.list']);
    expect(team.result.notice).toBeNull();
  });

  it('a member asking for billing is refused the way the Billing screen refuses', async () => {
    const owner = await me();
    const member = {
      ...owner,
      permissionKeys: owner.permissionKeys.filter((key) => key !== 'billing.read'),
    };
    const { result, prompt } = await ask(
      'Show me our billing and plan.',
      { en: 'Here is your plan.', steps: [{ toolKey: 'plan.summary', arguments: {} }] },
      member,
    );
    // The model is told it may not use the read, and asked to propose it anyway.
    expect(prompt).toMatch(/TOOLS THIS PERSON MAY NOT USE[^\n]*plan\.summary/);
    expect(prompt).not.toMatch(/^- plan\.summary /m);
    expect(result.steps).toEqual([]);
    expect(result.notice).toBe('permission_denied');
    expect(result.deniedToolKeys).toEqual(['plan.summary']);
    const audit = await platform.auditEvent.findFirst({
      where: { action: 'copilot.tool_refused', workspaceId: fixtures.a.workspaceId },
      orderBy: { occurredAt: 'desc' },
      select: { after: true },
    });
    expect(audit?.after).toEqual({ rejectedToolKeys: 'plan.summary' });
  });

  it('Stop mid-turn: no answer is stored and nothing is charged, even though the model answered', async () => {
    const session = await open();
    const authorization = await me();
    const before = await money(fixtures.a.workspaceId);
    const idempotencyKey = `prb-stop-${crypto.randomUUID()}`;
    // The model takes a moment to answer; Stop is pressed while it does.
    adapter.script.push({
      kind: 'text',
      text: answer('An answer nobody waited for.'),
      delayMs: 400,
    });
    const turn = CopilotOrchestrator.turnWith((fn) => inA((db) => fn(orchestratorIn(db))), {
      sessionId: session.id,
      request: 'Write a long essay about our brand.',
      authorization,
      planKey: null,
      idempotencyKey,
      expiresAt: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stopped = await inA((db) =>
      orchestratorIn(db).stopTurn({ authorization, sessionId: session.id, idempotencyKey }),
    );
    expect(stopped).toEqual({ stopped: true });
    await expect(turn).rejects.toMatchObject({ code: 'CONFLICT' });

    const after = await money(fixtures.a.workspaceId);
    expect(after.charges).toBe(before.charges);
    expect(after.balance).toBe(before.balance);
    expect(after.reserved).toBe(before.reserved);
    const rows = await platform.copilotMessage.findMany({
      where: { sessionId: session.id, idempotencyKey: { startsWith: idempotencyKey } },
      select: { role: true, status: true },
    });
    expect(rows).toEqual([{ role: 'USER', status: 'stopped' }]);
    const audit = await platform.auditEvent.count({
      where: { action: 'copilot.turn_stopped', resourceId: session.id },
    });
    expect(audit).toBeGreaterThan(0);
    // Stop on a turn that already finished changes nothing.
    await say('Hello again.');
    const late = await inA((db) =>
      orchestratorIn(db).stopTurn({
        authorization,
        sessionId: session.id,
        idempotencyKey: 'no-such-turn-key',
      }),
    );
    expect(late).toEqual({ stopped: false });
  });

  it('a stopped turn of another person, or another workspace, cannot be stopped from here', async () => {
    const session = await open();
    const authorization = await me();
    await expect(
      inWs(fixtures.b.workspaceId, (db) =>
        orchestratorIn(db, fixtures.b.workspaceId).stopTurn({
          authorization,
          sessionId: session.id,
          idempotencyKey: 'any-key-at-all',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
