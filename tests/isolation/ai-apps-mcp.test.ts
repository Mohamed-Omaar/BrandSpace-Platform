import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashSessionToken } from '@brandspace/auth';
import { ConfigurationService } from '@brandspace/config';
import { AI_APPS_FEATURE } from '@brandspace/entitlements';
import { buildServer } from '../../apps/api/src/server';
import { setAiAppsContextForTests } from '../../apps/api/src/ai-apps/context';
import { TOOL_NAMES } from '../../apps/api/src/ai-apps/tools';
import { captureConfig, type ActivatedConfig } from './config-activation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * D-566 — CONNECTED AI APPS, END TO END, WITH A REAL MCP CLIENT.
 *
 * CI never calls Claude or ChatGPT. The official MCP SDK's own client
 * (`@modelcontextprotocol/sdk`, Streamable HTTP) plays the AI app against the
 * real API on a local port, through the whole OAuth 2.1 flow the products use:
 *
 *   discovery (RFC 9728 / RFC 8414) → registration (RFC 7591) → the consent
 *   decision a signed-in person makes in Brandspace → code + PKCE S256 →
 *   tokens → every tool → refresh rotation → revocation.
 *
 * And the refusals the owner asked for: a permission the member lacks, another
 * workspace, brands outside the connection, a member downgraded or removed
 * after connecting, the feature switched off (globally, by kill switch), the
 * per-connection rate limit, revoke — and the leak test: no access token,
 * refresh token, code, verifier or app id ever lands in an audit row, a log
 * line, an error body, a tool result or the connections view. No tool ever
 * leaves a post approved, scheduled or published, and the credit ledger does
 * not move.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let server: Awaited<ReturnType<typeof buildServer>>;
let base: string;
let aiApps: ActivatedConfig;
let entitlements: ActivatedConfig;
let flags: ActivatedConfig;

const DASHBOARD = 'http://127.0.0.1:3001';
/** This suite registers many apps from one address; the per-address ceilings are tested on their own. */
const OPEN = {
  enabled: true,
  rateLimit: { windowSeconds: 60, maxCallsPerConnection: 500 },
  oauth: { registrationPerIpPerHour: 10_000, tokenPerIpPerMinute: 10_000 },
};
const REDIRECT = 'https://client.example.test/callback';
/** Every secret value this suite ever sees, for the leak test at the end. */
const secrets = new Set<string>();
const remember = <T extends string | undefined | null>(value: T): T => {
  if (value) secrets.add(value);
  return value;
};
const logged: string[] = [];
const toolTexts: string[] = [];
const errorBodies: string[] = [];

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  remember(verifier);
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function json(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (response.status >= 400) errorBodies.push(text);
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function form(path: string, fields: Record<string, string>) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await response.text();
  if (response.status >= 400) errorBodies.push(text);
  return {
    status: response.status,
    headers: response.headers,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

/** A signed-in customer session for a user, as the dashboard would forward it. */
async function sessionFor(userId: string, workspaceId: string): Promise<string> {
  const secret = `ai-apps-${randomUUID()}`;
  remember(secret);
  await platform.customerSession.create({
    data: {
      userId,
      tokenHash: hashSessionToken(secret),
      activeWorkspaceId: workspaceId,
      expiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000),
    },
  });
  return secret;
}

/** A member of workspace A holding one system role, with a session. */
async function memberWith(
  roleKey: string,
): Promise<{ userId: string; session: string; membershipId: string }> {
  const role = await platform.role.findFirstOrThrow({ where: { key: roleKey, workspaceId: null } });
  const user = await platform.user.create({
    data: {
      email: `ai-apps-${roleKey}-${randomUUID().slice(0, 8)}@example.local`,
      name: `AI apps ${roleKey}`,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      timezone: 'UTC',
    },
  });
  const membership = await platform.membership.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE',
      acceptedAt: new Date(),
      brandScope: [],
    },
  });
  return {
    userId: user.id,
    session: await sessionFor(user.id, fixtures.a.workspaceId),
    membershipId: membership.id,
  };
}

async function registerApp(name = 'Test AI app'): Promise<string> {
  const response = await json('POST', '/oauth/register', {
    client_name: name,
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  expect(response.status).toBe(201);
  return remember(response.body['client_id'] as string);
}

interface Grant {
  readonly access: string;
  readonly refresh: string;
  readonly clientId: string;
}

/** The whole authorization-code flow, as Claude or ChatGPT runs it. */
async function connect(
  session: string,
  options: {
    readonly brandMode?: 'all' | 'some';
    readonly brandIds?: string[];
    readonly scope?: string;
  } = {},
): Promise<Grant> {
  const clientId = await registerApp();
  const { verifier, challenge } = pkce();
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: options.scope ?? 'brandspace.read brandspace.write offline_access',
    state: 'state-123',
    resource: `${base}/mcp`,
  };
  const decided = await json(
    'POST',
    '/v1/ai-apps/authorize/decide',
    {
      ...params,
      decision: 'allow',
      workspaceId: fixtures.a.workspaceId,
      brandMode: options.brandMode ?? 'all',
      ...(options.brandIds ? { brandIds: options.brandIds } : {}),
    },
    { authorization: `Bearer ${session}` },
  );
  expect(decided.body['status']).toBe('redirect');
  const redirect = new URL(decided.body['redirectTo'] as string);
  expect(redirect.searchParams.get('state')).toBe('state-123');
  expect(redirect.searchParams.get('iss')).toBe(base);
  const code = remember(redirect.searchParams.get('code'))!;
  const token = await form('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: `${base}/mcp`,
  });
  expect(token.status).toBe(200);
  return {
    access: remember(token.body['access_token'] as string),
    refresh: remember(token.body['refresh_token'] as string),
    clientId,
  };
}

async function mcpClient(access: string): Promise<Client> {
  const client = new Client({ name: 'brandspace-ci', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${access}` } },
    }),
  );
  return client;
}

interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
  readonly data: Record<string, unknown>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
  };
  const text = result.content.map((c) => c.text).join('\n');
  toolTexts.push(text);
  return { isError: result.isError === true, text, data: result.structuredContent ?? {} };
}

/** A raw JSON-RPC tools/call, to read the HTTP status the client hides. */
async function rawCall(access: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${access}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  if (response.status >= 400) errorBodies.push(text);
  return { status: response.status, headers: response.headers, text };
}

const creditRows = () =>
  Promise.all([
    platform.creditTransaction.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    platform.aiUsageLedger.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    platform.aiRequest.count({ where: { workspaceId: fixtures.a.workspaceId } }),
  ]);

let owner: { userId: string; session: string };
let ownerGrant: Grant;
let ownerClient: Client;
let creditsBefore: number[];

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    logged.push(String(chunk));
    return true;
  }) as never);

  aiApps = await captureConfig(platform, 'ai-apps', { projected: false });
  entitlements = await captureConfig(platform, 'entitlements', { projected: true });
  flags = await captureConfig(platform, 'feature-flags', { projected: true });
  await aiApps.activate(OPEN);
  const currentEntitlements = (
    await platform.configurationVersion.findFirst({
      where: { domain: 'entitlements', environment: 'DEVELOPMENT', status: 'ACTIVE' },
      select: { payload: true },
    })
  )?.payload as { features?: unknown[]; planEntitlements?: unknown[] } | undefined;
  await entitlements.activate({
    features: [
      ...(currentEntitlements?.features ?? []).filter(
        (f) => (f as { key: string }).key !== AI_APPS_FEATURE,
      ),
      {
        key: AI_APPS_FEATURE,
        name: { en: 'Connect AI apps', ar: 'ربط تطبيقات الذكاء الاصطناعي' },
        valueType: 'boolean',
        defaultValue: false,
      },
    ],
    planEntitlements: currentEntitlements?.planEntitlements ?? [],
  });
  await setFlag({ globalEnabled: true });

  server = await buildServer();
  await server.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  setAiAppsContextForTests({
    configuration: new ConfigurationService({ prisma: platform, cacheTtlMs: 0 }),
    addresses: () => ({ api: base, dashboard: DASHBOARD }),
  });

  owner = {
    userId: fixtures.a.userId,
    session: await sessionFor(fixtures.a.userId, fixtures.a.workspaceId),
  };
  creditsBefore = await creditRows();
  ownerGrant = await connect(owner.session);
  ownerClient = await mcpClient(ownerGrant.access);
}, 120_000);

async function setFlag(flag: { globalEnabled?: boolean; killSwitch?: boolean }) {
  const current = (
    await platform.configurationVersion.findFirst({
      where: { domain: 'feature-flags', environment: 'DEVELOPMENT', status: 'ACTIVE' },
      select: { payload: true },
    })
  )?.payload as { flags?: { featureKey: string }[] } | undefined;
  await flags.activate({
    flags: [
      ...(current?.flags ?? []).filter((f) => f.featureKey !== AI_APPS_FEATURE),
      {
        featureKey: AI_APPS_FEATURE,
        killSwitch: flag.killSwitch ?? false,
        globalEnabled: flag.globalEnabled ?? null,
      },
    ],
  });
}

afterAll(async () => {
  vi.restoreAllMocks();
  await ownerClient?.close().catch(() => undefined);
  setAiAppsContextForTests(null);
  await aiApps?.restore();
  await entitlements?.restore();
  await flags?.restore();
  await server?.close();
  await app.$disconnect();
  await platform.$disconnect();
});

describe('D-566 · discovery, as the MCP spec and RFC 9728 / RFC 8414 require', () => {
  it('protected resource metadata names this server and its one authorization server', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const { status, body } = await json('GET', path);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
      });
    }
  });

  it('authorization server metadata: S256 only, public clients, offline_access, iss in the response', async () => {
    const { body } = await json('GET', '/.well-known/oauth-authorization-server');
    expect(body).toMatchObject({
      issuer: base,
      authorization_endpoint: `${DASHBOARD}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      authorization_response_iss_parameter_supported: true,
    });
    expect(body['scopes_supported']).toContain('offline_access');
  });

  it('POST /mcp with no token is a 401 naming the metadata; GET is 405', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="brandspace.read brandspace.write"`,
    );
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });

  it('a token in the query string is never read', async () => {
    const response = await fetch(`${base}/mcp?access_token=${ownerGrant.access}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('a browser origin not on the allow list is refused with 403', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example.test',
        authorization: `Bearer ${ownerGrant.access}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(403);
  });
});

describe('D-566 · registration and the authorization code', () => {
  it('refuses a redirect that is neither https nor loopback', async () => {
    const response = await json('POST', '/oauth/register', {
      client_name: 'x',
      redirect_uris: ['http://evil.example.test/cb'],
    });
    expect(response.status).toBe(400);
    expect(response.body['error']).toBe('invalid_redirect_uri');
  });

  it('the consent check names the app and offers only workspaces where AI apps are on', async () => {
    const clientId = await registerApp('Claude');
    const { challenge } = pkce();
    const checked = await json(
      'POST',
      '/v1/ai-apps/authorize/check',
      {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 's',
      },
      { authorization: `Bearer ${owner.session}` },
    );
    expect(checked.body).toMatchObject({
      status: 'ok',
      client: { name: 'Claude', redirectHost: 'client.example.test' },
    });
    const workspaces = checked.body['workspaces'] as {
      id: string;
      available: boolean;
      brands: { id: string }[];
    }[];
    const a = workspaces.find((w) => w.id === fixtures.a.workspaceId)!;
    expect(a.available).toBe(true);
    expect(a.brands.map((b) => b.id)).toContain(fixtures.a.brandId);
    expect(workspaces.some((w) => w.id === fixtures.b.workspaceId)).toBe(false);
  });

  it('an unknown app or an unregistered redirect is an error in Brandspace, never a redirect', async () => {
    const { challenge } = pkce();
    const bad = await json(
      'POST',
      '/v1/ai-apps/authorize/check',
      {
        response_type: 'code',
        client_id: `bsp_cli_${'x'.repeat(40)}`,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      { authorization: `Bearer ${owner.session}` },
    );
    expect(bad.body).toEqual({ status: 'error', code: 'INVALID_CLIENT' });
    const clientId = await registerApp();
    const wrong = await json(
      'POST',
      '/v1/ai-apps/authorize/check',
      {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://other.example.test/cb',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      { authorization: `Bearer ${owner.session}` },
    );
    expect(wrong.body).toEqual({ status: 'error', code: 'INVALID_REDIRECT' });
  });

  it('PKCE is required: no challenge goes back to the app as invalid_request', async () => {
    const clientId = await registerApp();
    const checked = await json(
      'POST',
      '/v1/ai-apps/authorize/check',
      { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'z' },
      { authorization: `Bearer ${owner.session}` },
    );
    expect(checked.body['status']).toBe('redirect');
    const url = new URL(checked.body['redirectTo'] as string);
    expect(url.searchParams.get('error')).toBe('invalid_request');
    expect(url.searchParams.get('state')).toBe('z');
  });

  it('cancel sends access_denied back with the state', async () => {
    const clientId = await registerApp();
    const { challenge } = pkce();
    const cancelled = await json(
      'POST',
      '/v1/ai-apps/authorize/decide',
      {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'c',
        decision: 'cancel',
      },
      { authorization: `Bearer ${owner.session}` },
    );
    const url = new URL(cancelled.body['redirectTo'] as string);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('code')).toBeNull();
  });

  it('a wrong verifier, a wrong redirect, a wrong resource and a reused code are all refused', async () => {
    const attempt = async (tamper: Record<string, string>) => {
      const clientId = await registerApp();
      const { verifier, challenge } = pkce();
      const decided = await json(
        'POST',
        '/v1/ai-apps/authorize/decide',
        {
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          decision: 'allow',
          workspaceId: fixtures.a.workspaceId,
        },
        { authorization: `Bearer ${owner.session}` },
      );
      const code = remember(
        new URL(decided.body['redirectTo'] as string).searchParams.get('code'),
      )!;
      const fields = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${base}/mcp`,
        ...tamper,
      };
      return {
        first: await form('/oauth/token', fields),
        again: () =>
          form('/oauth/token', {
            ...fields,
            code_verifier: verifier,
            redirect_uri: REDIRECT,
            resource: `${base}/mcp`,
          }),
      };
    };
    const wrongVerifier = await attempt({ code_verifier: randomBytes(32).toString('base64url') });
    expect(wrongVerifier.first.status).toBe(400);
    expect(wrongVerifier.first.body['error']).toBe('invalid_grant');
    // The code was spent by the wrong try: the right verifier cannot use it now.
    expect((await wrongVerifier.again()).body['error']).toBe('invalid_grant');
    expect(
      (await attempt({ redirect_uri: 'https://client.example.test/other' })).first.body['error'],
    ).toBe('invalid_grant');
    expect(
      (await attempt({ resource: 'https://elsewhere.example.test/mcp' })).first.body['error'],
    ).toBe('invalid_target');
    const reused = await attempt({});
    expect(reused.first.status).toBe(200);
    remember(reused.first.body['access_token'] as string);
    remember(reused.first.body['refresh_token'] as string);
    expect((await reused.again()).body['error']).toBe('invalid_grant');
  });
});

describe('D-566 · the tools, as the person who connected', () => {
  it('lists exactly the eleven approved tools, each annotated', async () => {
    const { tools } = await ownerClient.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const writes = tools
      .filter((t) => t.annotations?.readOnlyHint === false)
      .map((t) => t.name)
      .sort();
    expect(writes).toEqual(['create_post', 'update_post']);
    for (const tool of tools) expect(tool.annotations?.openWorldHint).toBe(false);
  });

  it('whoami and list_brands name this person, this workspace and its brands only', async () => {
    const who = await call(ownerClient, 'whoami');
    expect(who.isError).toBe(false);
    expect(who.data).toMatchObject({
      workspace: { id: fixtures.a.workspaceId },
      app: { name: 'Test AI app' },
      permissions: { canApproveScheduleOrPublish: false },
    });
    const brands = await call(ownerClient, 'list_brands');
    const ids = (brands.data['brands'] as { id: string }[]).map((b) => b.id);
    expect(ids).toContain(fixtures.a.brandId);
    expect(ids).not.toContain(fixtures.b.brandId);
  });

  it('get_help describes channels from configuration, en and ar, and what only a person may do', async () => {
    const en = await call(ownerClient, 'get_help', { topic: 'approvals' });
    expect(en.isError).toBe(false);
    expect((en.data['channels'] as unknown[]).length).toBeGreaterThan(0);
    expect(en.data['whatOnlyAPersonCanDo']).toContain('Schedule or publish a post');
    const ar = await call(ownerClient, 'get_help', { locale: 'ar' });
    expect(JSON.stringify(ar.data)).toMatch(/[؀-ۿ]/);
  });

  it('get_brand_summary returns approved facts only', async () => {
    const summary = await call(ownerClient, 'get_brand_summary', { brandId: fixtures.a.brandId });
    expect(summary.isError).toBe(false);
    const facts = summary.data['facts'] as { body: string }[];
    const approved = await platform.brandKnowledgeItem.count({
      where: {
        brandId: fixtures.a.brandId,
        status: { in: ['ACTIVE', 'STALE'] },
        OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
      },
    });
    expect(facts.length).toBe(summary.data['brandBrainUsedForWriting'] ? approved : 0);
  });

  let createdId = '';
  it('create_post writes a DRAFT with a proposed time, sends it for review, and nothing is scheduled', async () => {
    const thursday = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const channel = (
      (await call(ownerClient, 'get_help')).data['channels'] as { key: string; formats: string[] }[]
    ).find((c) => c.formats.includes('post'))!.key;
    const created = await call(ownerClient, 'create_post', {
      brandId: fixtures.a.brandId,
      format: 'post',
      channels: [channel],
      caption: 'Our weekend offer is here.\u0007',
      hashtags: ['#weekend', 'offer'],
      proposedTime: `${thursday}T18:00`,
      sendForReview: true,
    });
    expect(created.isError, created.text).toBe(false);
    expect(created.data).toMatchObject({
      status: 'in_review',
      proposedTime: `${thursday}T18:00`,
      onCalendar: true,
    });
    createdId = created.data['id'] as string;
    const row = await platform.contentItem.findUniqueOrThrow({
      where: { id: createdId },
      include: { variants: true, calendarSlots: true },
    });
    expect(row.status).toBe('IN_REVIEW');
    expect(row.origin).toBe('HUMAN');
    expect(row.publishChoice).toBe('PICK');
    expect(row.calendarSlots).toEqual([]);
    expect(row.variants[0]!.body).toBe('Our weekend offer is here.');
    expect(row.variants[0]!.hashtags).toEqual(['weekend', 'offer']);

    const calendar = await call(ownerClient, 'get_calendar', { from: thursday, to: thursday });
    const items = (
      calendar.data['days'] as { items: { postId: string; kind: string; time: string }[] }[]
    ).flatMap((d) => d.items);
    expect(items).toContainEqual(
      expect.objectContaining({ postId: createdId, kind: 'proposed', time: '18:00' }),
    );
  });

  it('a retried create (the same input) is one post, not two', async () => {
    const before = await platform.contentItem.count({
      where: { workspaceId: fixtures.a.workspaceId },
    });
    const input = {
      brandId: fixtures.a.brandId,
      format: 'post',
      channels: ['instagram'],
      caption: 'Retry me once',
    };
    const first = await call(ownerClient, 'create_post', input);
    const second = await call(ownerClient, 'create_post', input);
    if (!first.isError) {
      expect(second.data['id']).toBe(first.data['id']);
      expect(
        await platform.contentItem.count({ where: { workspaceId: fixtures.a.workspaceId } }),
      ).toBe(before + 1);
    }
  });

  it('update_post changes a draft, and refuses a post in review in plain words', async () => {
    const inReview = await call(ownerClient, 'update_post', {
      postId: createdId,
      caption: 'Changed',
    });
    expect(inReview.isError).toBe(true);
    expect(inReview.text).toMatch(/can’t be changed here: it is in review/);
    const draft = await call(ownerClient, 'create_post', {
      brandId: fixtures.a.brandId,
      format: 'post',
      channels: ['instagram'],
      caption: 'First words',
    });
    expect(draft.isError, draft.text).toBe(false);
    const changed = await call(ownerClient, 'update_post', {
      postId: draft.data['id'],
      caption: 'Better words',
      proposedTime: null,
    });
    expect(changed.isError, changed.text).toBe(false);
    expect((changed.data['channels'] as { caption: string }[])[0]!.caption).toBe('Better words');
  });

  it('list_posts and get_post read this workspace', async () => {
    const listed = await call(ownerClient, 'list_posts', { limit: 50 });
    const ids = (listed.data['posts'] as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(createdId);
    const one = await call(ownerClient, 'get_post', { postId: createdId });
    expect(one.data).toMatchObject({
      id: createdId,
      status: 'in_review',
      review: { status: 'pending' },
    });
    expect(one.data['link']).toBe(`${DASHBOARD}/en/compose?item=${createdId}`);
  });

  it('get_performance never invents a number; with no connected account it says so', async () => {
    await platform.socialConnection.updateMany({
      where: { workspaceId: fixtures.a.workspaceId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    const perf = await call(ownerClient, 'get_performance', {
      brandId: fixtures.a.brandId,
      period: '28d',
    });
    expect(perf.isError, perf.text).toBe(false);
    expect(perf.data['connected']).toBe(false);
    for (const metric of perf.data['metrics'] as { value: unknown; absent: unknown }[]) {
      expect(metric.value).toBeNull();
      expect(metric.absent).toBe('no_connection');
    }
    const report = await call(ownerClient, 'get_report', {
      brandId: fixtures.a.brandId,
      from: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
    });
    expect(report.isError, report.text).toBe(false);
    expect(report.data['performance']).toEqual({ available: false, reason: 'no_connection' });
    expect((report.data['posts'] as { inReview: number }).inReview).toBeGreaterThanOrEqual(1);
  });

  it('no tool ever leaves a post approved, scheduled or published', async () => {
    const touched = await platform.auditEvent.findMany({
      where: { workspaceId: fixtures.a.workspaceId, action: 'ai_app.tool.called' },
      select: { after: true },
    });
    const postIds = [
      ...new Set(touched.map((t) => (t.after as { postId?: string }).postId).filter(Boolean)),
    ] as string[];
    expect(postIds.length).toBeGreaterThan(0);
    const posts = await platform.contentItem.findMany({
      where: { id: { in: postIds } },
      include: { calendarSlots: true },
    });
    for (const post of posts) {
      expect(['DRAFT', 'IN_REVIEW']).toContain(post.status);
      expect(post.calendarSlots).toEqual([]);
      expect(post.publishChoice).not.toBe('AFTER_APPROVAL');
    }
  });
});

describe('D-566 · refusals', () => {
  it('a permission the member lacks is refused in plain words, and audited DENIED', async () => {
    const copywriter = await memberWith('copywriter');
    const grant = await connect(copywriter.session);
    const client = await mcpClient(grant.access);
    const perf = await call(client, 'get_performance', {
      brandId: fixtures.a.brandId,
      period: '7d',
    });
    expect(perf.isError).toBe(true);
    expect(perf.text).toBe('You don’t have permission to read performance in this workspace.');
    await client.close();

    const viewer = await memberWith('client_viewer');
    const viewerClient = await mcpClient((await connect(viewer.session)).access);
    const create = await call(viewerClient, 'create_post', {
      brandId: fixtures.a.brandId,
      format: 'post',
      channels: ['instagram'],
      caption: 'x',
    });
    expect(create.text).toBe('You don’t have permission to create posts in this workspace.');
    await viewerClient.close();

    const denied = await platform.auditEvent.count({
      where: {
        workspaceId: fixtures.a.workspaceId,
        action: 'ai_app.tool.called',
        outcome: 'DENIED',
        actorId: { in: [copywriter.userId, viewer.userId] },
      },
    });
    expect(denied).toBeGreaterThanOrEqual(2);
  });

  it('another workspace is "not found", worded exactly like a true miss', async () => {
    const miss = await call(ownerClient, 'get_post', { postId: randomUUID() });
    const other = await call(ownerClient, 'get_post', { postId: fixtures.b.contentItemId });
    expect(other.isError).toBe(true);
    expect(other.text).toBe(miss.text);
    const brand = await call(ownerClient, 'get_brand_summary', { brandId: fixtures.b.brandId });
    expect(brand.text).toBe(miss.text);
    const listed = await call(ownerClient, 'list_posts', { limit: 50 });
    expect(JSON.stringify(listed.data)).not.toContain(fixtures.b.contentItemId);
  });

  it('a connection limited to brands the member cannot see sees no brand', async () => {
    const grant = await connect(owner.session, {
      brandMode: 'some',
      brandIds: [fixtures.a.brandId],
    });
    const row = await platform.aiAppConnection.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      where: { workspaceId: fixtures.a.workspaceId },
    });
    expect(row.brandIds).toEqual([fixtures.a.brandId]);
    // Narrow it to a brand id that is not the member's: nothing is visible.
    await platform.aiAppConnection.update({
      where: { id: row.id },
      data: { brandIds: [randomUUID()] },
    });
    const client = await mcpClient(grant.access);
    expect(((await call(client, 'list_brands')).data['brands'] as unknown[]).length).toBe(0);
    await client.close();
  });

  it('a member downgraded after connecting loses the power at the next call; a removed member’s token stops', async () => {
    const editor = await memberWith('workspace_admin');
    const grant = await connect(editor.session);
    const client = await mcpClient(grant.access);
    const viewerRole = await platform.role.findFirstOrThrow({
      where: { key: 'client_viewer', workspaceId: null },
    });
    await platform.membership.update({
      where: { id: editor.membershipId },
      data: { roleId: viewerRole.id },
    });
    const create = await call(client, 'create_post', {
      brandId: fixtures.a.brandId,
      format: 'post',
      channels: ['instagram'],
      caption: 'x',
    });
    expect(create.text).toBe('You don’t have permission to create posts in this workspace.');
    await platform.membership.update({
      where: { id: editor.membershipId },
      data: { status: 'REMOVED' },
    });
    expect((await rawCall(grant.access, 'whoami')).status).toBe(401);
    await client.close();
  });

  it('the feature switched off, or killed for the plan, refuses tool calls in plain words', async () => {
    await aiApps.activate({ enabled: false });
    expect((await call(ownerClient, 'whoami')).text).toBe(
      'AI apps are turned off for this workspace.',
    );
    await aiApps.activate(OPEN);
    await setFlag({ killSwitch: true });
    expect((await call(ownerClient, 'whoami')).text).toBe(
      'AI apps are not included in this workspace’s plan.',
    );
    await setFlag({ globalEnabled: true });
    expect((await call(ownerClient, 'whoami')).isError).toBe(false);
  });

  it('the rate limit: the call over the ceiling is a 429 with Retry-After, per connection', async () => {
    const grant = await connect(owner.session);
    const other = await connect(owner.session);
    await aiApps.activate({
      ...OPEN,
      rateLimit: { windowSeconds: 3_600, maxCallsPerConnection: 3 },
    });
    for (let i = 0; i < 3; i += 1) expect((await rawCall(grant.access, 'whoami')).status).toBe(200);
    const over = await rawCall(grant.access, 'whoami');
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(over.text).toContain('Too many requests from this app');
    expect((await rawCall(other.access, 'whoami')).status).toBe(200);
    await aiApps.activate(OPEN);
  });

  it('registration and the token endpoint are limited per source address', async () => {
    await aiApps.activate({
      ...OPEN,
      oauth: { registrationPerIpPerHour: 1, tokenPerIpPerMinute: 1 },
    });
    const register = await json('POST', '/oauth/register', {
      client_name: 'x',
      redirect_uris: [REDIRECT],
    });
    expect(register.status).toBe(429);
    expect(register.headers.get('retry-after')).toMatch(/^\d+$/);
    const token = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: 'bsp_rt_x',
      client_id: 'bsp_cli_x',
    });
    expect([429, 400]).toContain(token.status);
    const again = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: 'bsp_rt_x',
      client_id: 'bsp_cli_x',
    });
    expect(again.status).toBe(429);
    await aiApps.activate(OPEN);
  });
});

describe('D-566 · refresh, revoke, credits and the leak test', () => {
  it('refresh rotates; presenting the old refresh token again revokes the whole connection', async () => {
    const grant = await connect(owner.session);
    const rotated = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: grant.refresh,
      client_id: grant.clientId,
    });
    expect(rotated.status).toBe(200);
    remember(rotated.body['access_token'] as string);
    const next = remember(rotated.body['refresh_token'] as string);
    expect(next).not.toBe(grant.refresh);
    const reused = await form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: grant.refresh,
      client_id: grant.clientId,
    });
    expect(reused.body['error']).toBe('invalid_grant');
    // Reuse killed the connection: the new tokens die with it.
    expect(
      (
        await form('/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: next,
          client_id: grant.clientId,
        })
      ).body['error'],
    ).toBe('invalid_grant');
    expect((await rawCall(rotated.body['access_token'] as string, 'whoami')).status).toBe(401);
  });

  it('Settings shows the connection, and Revoke ends it at the next call', async () => {
    const grant = await connect(owner.session);
    const listed = await json('GET', '/v1/ai-apps/connections', undefined, {
      authorization: `Bearer ${owner.session}`,
    });
    const connections = listed.body['connections'] as {
      id: string;
      app: string;
      lastUsedAt: string | null;
    }[];
    expect(connections.length).toBeGreaterThan(0);
    const target = connections[0]!;
    expect(target.app).toBe('Test AI app');
    const noConfirm = await json(
      'POST',
      `/v1/ai-apps/connections/${target.id}/revoke`,
      {},
      { authorization: `Bearer ${owner.session}` },
    );
    expect(noConfirm.status).toBe(422);
    const revoked = await json(
      'POST',
      `/v1/ai-apps/connections/${target.id}/revoke`,
      { confirm: true },
      { authorization: `Bearer ${owner.session}` },
    );
    expect(revoked.status).toBe(200);
    expect(
      (await platform.aiAppConnection.findUniqueOrThrow({ where: { id: target.id } })).status,
    ).toBe('REVOKED');
    // The newest connection is the one just made; revoke it via the RFC 7009 endpoint too.
    const ended = await form('/oauth/revoke', { token: grant.refresh, client_id: grant.clientId });
    expect(ended.status).toBe(200);
    expect((await rawCall(grant.access, 'whoami')).status).toBe(401);
  });

  it('a member cannot see or revoke somebody else’s connection without integrations.manage', async () => {
    const writer = await memberWith('copywriter');
    const mine = await json('GET', '/v1/ai-apps/connections', undefined, {
      authorization: `Bearer ${writer.session}`,
    });
    expect((mine.body['connections'] as unknown[]).length).toBe(0);
    const ownerConnection = await platform.aiAppConnection.findFirstOrThrow({
      where: { userId: owner.userId, status: 'ACTIVE' },
    });
    const attempt = await json(
      'POST',
      `/v1/ai-apps/connections/${ownerConnection.id}/revoke`,
      { confirm: true },
      { authorization: `Bearer ${writer.session}` },
    );
    expect(attempt.status).toBe(404);
  });

  it('no AI app call spent a credit or reached the AI gateway', async () => {
    expect(await creditRows()).toEqual(creditsBefore);
  });

  it('every tool call is audited: who, which app, what', async () => {
    const rows = await platform.auditEvent.findMany({
      where: { workspaceId: fixtures.a.workspaceId, action: 'ai_app.tool.called' },
      select: { actorType: true, actorId: true, after: true },
    });
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      expect(row.actorType).toBe('USER');
      expect(row.after).toMatchObject({
        app: expect.any(String),
        tool: expect.any(String),
        outcome: expect.any(String),
      });
    }
  });

  it('no token, refresh token, code, verifier or app id appears anywhere it could leak', async () => {
    expect(secrets.size).toBeGreaterThan(20);
    const audit = JSON.stringify(
      await platform.auditEvent.findMany({
        where: {
          OR: [{ workspaceId: fixtures.a.workspaceId }, { action: { startsWith: 'ai_app.' } }],
        },
      }),
    );
    const view = JSON.stringify(
      (
        await json('GET', '/v1/ai-apps/connections', undefined, {
          authorization: `Bearer ${owner.session}`,
        })
      ).body,
    );
    const stored = JSON.stringify(
      await platform.aiAppToken.findMany({ where: { workspaceId: fixtures.a.workspaceId } }),
    );
    const places: Record<string, string> = {
      audit,
      logs: logged.join('\n'),
      'tool results': toolTexts.join('\n'),
      'error bodies': errorBodies.join('\n'),
      'connections view': view,
      'stored tokens': stored,
    };
    for (const secret of secrets) {
      for (const [place, text] of Object.entries(places)) {
        if (secret.startsWith('ai-apps-')) continue; // customer session secrets, not this feature's
        expect(text.includes(secret), `${secret.slice(0, 12)}… found in ${place}`).toBe(false);
      }
    }
  });
});
