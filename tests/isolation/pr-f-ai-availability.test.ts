import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashSessionToken } from '@brandspace/auth';
import { AI_TASKS } from '@brandspace/ai-gateway';
import type { PrismaClient } from '@brandspace/database';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import { captureConfig, type ActivatedConfig } from './config-activation';

/**
 * PR F (b), Q9, D-507 — `GET /v1/ai/availability`, through the real handler.
 *
 *   - It needs a signed-in session; without one there is no answer.
 *   - It answers for the session's OWN workspace only: a rule that makes AI
 *     available to Workspace B never shows in Workspace A's answer, and naming
 *     B in the query or a header changes nothing.
 *   - The body is `{ tasks: { <task>: true | false } }` and nothing else — no
 *     provider, model, key or error detail.
 *   - Switching AI off and on in the Control Center (activating `ai.providers`)
 *     flips the answer on the SAME running server: no release, no restart.
 *   - A development double never counts in production: production registers
 *     no adapter for it, and its key is a development-only provider.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let providers: ActivatedConfig;
let models: ActivatedConfig;
let routing: ActivatedConfig;
let tokenA: string;
let tokenB: string;

type Injected = { statusCode: number; body: string; headers: Record<string, unknown> };
type Server = {
  inject(options: Record<string, unknown>): Promise<Injected>;
  close(): Promise<unknown>;
  ready(): Promise<unknown>;
};
let server: Server;

async function sessionFor(userId: string, workspaceId: string): Promise<string> {
  const token = `prf-ai-${randomUUID()}`;
  await platform.customerSession.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token),
      activeWorkspaceId: workspaceId,
      expiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000),
    },
  });
  return token;
}

async function ask(
  token: string | null,
  extra: { url?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> | null; cache: unknown }> {
  const response = await server.inject({
    method: 'GET',
    url: extra.url ?? '/v1/ai/availability',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra.headers },
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: response.statusCode, body, cache: response.headers['cache-control'] };
}

/*
 * THIS SUITE'S OWN AI CONFIGURATION: the development mock provider, one text
 * model and a route per task the assertions name. Written and put back by the
 * suite itself, so the answer never depends on what another suite or a seed
 * left active.
 */
const MOCK = 'mock';
const MODEL = 'mock-fast';

function providersWith(status: 'active' | 'disabled'): Record<string, unknown> {
  return {
    providers: [
      {
        key: MOCK,
        name: 'Mock provider (development only)',
        baseUrl: 'https://mock.invalid',
        apiKeySecretRef: 'ai-provider/mock/development/api-key',
        status,
        timeoutMs: 30_000,
        maxConcurrency: 8,
        noTrainingGuarantee: true,
        dataRetentionPolicy: 'zero_retention',
        privacyReviewRef: 'in-process mock adapter; no data leaves the process',
      },
    ],
  };
}

const MODELS = {
  models: [
    {
      key: MODEL,
      providerKey: MOCK,
      displayName: 'Mock fast (development only)',
      modality: 'text',
      qualityTier: 'fast',
      status: 'beta',
      disableSwitch: false,
      inputCostPerUnitMicroMinor: 15_000,
      outputCostPerUnitMicroMinor: 60_000,
      costUnit: '1k_tokens',
      costCurrency: 'USD',
      qualityBenchmarkRef: null,
    },
  ],
};

function rule(taskKey: string, scope: { workspaceId: string } | null = null) {
  return {
    taskKey,
    scope: scope ? 'workspace' : 'global',
    planKey: null,
    workspaceId: scope?.workspaceId ?? null,
    primaryModelKey: MODEL,
    fallbackModelKeys: [],
    timeoutMs: 10_000,
    maxCostPerRequestMinor: null,
    priority: 0,
    parameters: {
      temperature: 0.3,
      maxOutputTokens: 400,
      promptTemplateVersion: 1,
      persistOutput: false,
      outputRetentionDays: null,
    },
    retryPolicy: { maxAttempts: 1, backoff: 'none', initialDelayMs: 0, jitter: false },
    moderateInput: false,
    moderationModelKey: null,
  };
}

/** Copilot and captions routed globally — the suite's baseline. */
const ROUTING = { rules: [rule('copilot.chat'), rule('caption.generate')] };

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  providers = await captureConfig(platform, 'ai.providers', { projected: false });
  models = await captureConfig(platform, 'ai.models', { projected: false });
  routing = await captureConfig(platform, 'ai.routing', { projected: false });
  await providers.activate(providersWith('active'));
  await models.activate(MODELS);
  await routing.activate(ROUTING);
  tokenA = await sessionFor(fixtures.a.userId, fixtures.a.workspaceId);
  tokenB = await sessionFor(fixtures.b.userId, fixtures.b.workspaceId);
  vi.resetModules();
  const { buildServer } = await import('../../apps/api/src/server');
  server = (await buildServer()) as unknown as Server;
  await server.ready();
}, 60_000);

afterAll(async () => {
  await server?.close();
  await routing?.restore();
  await models?.restore();
  await providers?.restore();
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('PR F (b) · who may ask', () => {
  it('no session, no answer', async () => {
    const answer = await ask(null);
    expect(answer.status).toBe(401);
    expect(answer.body?.['tasks']).toBeUndefined();
  });

  it('an invented token is no session either', async () => {
    const answer = await ask(`prf-ai-${randomUUID()}`);
    expect(answer.status).toBe(401);
    expect(answer.body?.['tasks']).toBeUndefined();
  });
});

describe('PR F (b) · what the answer carries', () => {
  it('per task, true or false, and nothing else; never cached', async () => {
    await providers.activate(providersWith('active'));
    const answer = await ask(tokenA);
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body ?? {})).toEqual(['tasks']);
    const tasks = answer.body?.['tasks'] as Record<string, unknown>;
    expect(Object.keys(tasks).sort()).toEqual(AI_TASKS.map((task) => task.key).sort());
    for (const value of Object.values(tasks)) expect(typeof value).toBe('boolean');
    // No provider, model, key or route detail anywhere in it.
    const text = JSON.stringify(answer.body);
    for (const leak of ['mock', 'provider', 'model', 'secret', 'api-key', 'error']) {
      expect(text.toLowerCase()).not.toContain(leak);
    }
    expect(answer.cache).toBe('private, no-store');
  });
});

describe('PR F (b) · the session’s own workspace only', () => {
  it('a rule for Workspace B is invisible to Workspace A, however A asks', async () => {
    await providers.activate(providersWith('active'));
    // Copilot routed ONLY for Workspace B; every other task as before.
    await routing.activate({
      rules: [
        rule('copilot.chat', { workspaceId: fixtures.b.workspaceId }),
        rule('caption.generate'),
      ],
    });
    const b = await ask(tokenB);
    expect((b.body?.['tasks'] as Record<string, boolean>)['copilot.chat']).toBe(true);

    for (const attempt of [
      {},
      { url: `/v1/ai/availability?workspaceId=${fixtures.b.workspaceId}` },
      { headers: { 'x-workspace-id': fixtures.b.workspaceId } },
    ]) {
      const a = await ask(tokenA, attempt);
      expect(a.status).toBe(200);
      expect((a.body?.['tasks'] as Record<string, boolean>)['copilot.chat']).toBe(false);
      // The rest are unchanged for A: the difference is the workspace rule alone.
      expect((a.body?.['tasks'] as Record<string, boolean>)['caption.generate']).toBe(true);
    }
    await routing.activate(ROUTING);
  });
});

describe('PR F (b) · switching AI in the Control Center flips the answer, with no release', () => {
  it('off, on and off again on the same running server', async () => {
    await routing.activate(ROUTING);

    await providers.activate(providersWith('disabled'));
    const off = (await ask(tokenA)).body?.['tasks'] as Record<string, boolean>;
    expect(Object.values(off).every((value) => value === false)).toBe(true);

    await providers.activate(providersWith('active'));
    const on = (await ask(tokenA)).body?.['tasks'] as Record<string, boolean>;
    expect(on['copilot.chat']).toBe(true);
    expect(on['caption.generate']).toBe(true);

    await providers.activate(providersWith('disabled'));
    const offAgain = (await ask(tokenA)).body?.['tasks'] as Record<string, boolean>;
    expect(offAgain['copilot.chat']).toBe(false);
  });
});

describe('PR F (b) · a development double never counts in production', () => {
  it('production registers no development double, and the mock is a development-only provider', async () => {
    const { registeredAdapters, DEVELOPMENT_ONLY_AI } =
      await import('../../apps/api/src/routes/ai-availability');
    // D-573: production now registers the real adapter(s), and still never the mock.
    expect(registeredAdapters(true).has('mock')).toBe(false);
    expect([...registeredAdapters(true)].every((key) => !DEVELOPMENT_ONLY_AI.has(key))).toBe(true);
    expect(registeredAdapters(false).has('mock')).toBe(true);
    expect(DEVELOPMENT_ONLY_AI.has('mock')).toBe(true);
  });
});
