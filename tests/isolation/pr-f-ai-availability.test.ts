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
let routing: ActivatedConfig;
let originalProviders: Record<string, unknown>;
let originalRouting: { rules: Record<string, unknown>[] } & Record<string, unknown>;
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

async function activeActive(domain: string): Promise<Record<string, unknown>> {
  const row = await platform.configurationVersion.findFirstOrThrow({
    where: { domain, environment: 'DEVELOPMENT', status: 'ACTIVE' },
    select: { payload: true },
  });
  return row.payload as Record<string, unknown>;
}

function withProviderStatus(status: string): Record<string, unknown> {
  const list = (originalProviders['providers'] as Record<string, unknown>[]).map((provider) => ({
    ...provider,
    status,
  }));
  return { ...originalProviders, providers: list };
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  originalProviders = await activeActive('ai.providers');
  originalRouting = (await activeActive('ai.routing')) as typeof originalRouting;
  providers = await captureConfig(platform, 'ai.providers', { projected: false });
  routing = await captureConfig(platform, 'ai.routing', { projected: false });
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
    await providers.activate(withProviderStatus('active'));
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
    await providers.activate(withProviderStatus('active'));
    // Copilot routed ONLY for Workspace B; every other task as before.
    await routing.activate({
      ...originalRouting,
      rules: originalRouting.rules.map((rule) =>
        rule['taskKey'] === 'copilot.chat'
          ? { ...rule, scope: 'workspace', workspaceId: fixtures.b.workspaceId }
          : rule,
      ),
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
    await routing.activate(originalRouting);
  });
});

describe('PR F (b) · switching AI in the Control Center flips the answer, with no release', () => {
  it('off, on and off again on the same running server', async () => {
    await routing.activate(originalRouting);

    await providers.activate(withProviderStatus('disabled'));
    const off = (await ask(tokenA)).body?.['tasks'] as Record<string, boolean>;
    expect(Object.values(off).every((value) => value === false)).toBe(true);

    await providers.activate(withProviderStatus('active'));
    const on = (await ask(tokenA)).body?.['tasks'] as Record<string, boolean>;
    expect(on['copilot.chat']).toBe(true);
    expect(on['caption.generate']).toBe(true);

    await providers.activate(withProviderStatus('disabled'));
    const offAgain = (await ask(tokenA)).body?.['tasks'] as Record<string, boolean>;
    expect(offAgain['copilot.chat']).toBe(false);
  });
});

describe('PR F (b) · a development double never counts in production', () => {
  it('production registers no adapter, and the mock is a development-only provider', async () => {
    const { registeredAdapters, DEVELOPMENT_ONLY_AI } =
      await import('../../apps/api/src/routes/ai-availability');
    expect([...registeredAdapters(true)]).toEqual([]);
    expect(registeredAdapters(false).has('mock')).toBe(true);
    expect(DEVELOPMENT_ONLY_AI.has('mock')).toBe(true);
  });
});
