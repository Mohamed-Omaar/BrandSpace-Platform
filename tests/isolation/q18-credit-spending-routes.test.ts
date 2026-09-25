import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSessionToken } from '@brandspace/auth';
import type { PrismaClient } from '@brandspace/database';
import { buildServer } from '../../apps/api/src/server';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * Q18 (D-315) — EVERY ROUTE THAT SPENDS AI CREDITS ALSO REQUIRES `copilot.use`,
 * proven through the real HTTP handlers.
 *
 * Two members of the same workspace hold every feature key the spending routes
 * name. One also holds `copilot.use`; the other does not. Each request carries
 * an empty body, so a caller who passes the permission gate is refused by the
 * body's validation (4xx, never 404) BEFORE anything is reserved — and the
 * caller without `copilot.use` is refused at the gate with the same 404 a
 * genuine miss gets. Nothing is quoted, reserved or charged for either.
 *
 * The quote routes spend nothing, and stay on their read keys: the member
 * without `copilot.use` still reaches them.
 */

const FEATURE_KEYS = [
  'workspace.read',
  'content.read',
  'content.create',
  'content.edit',
  'assets.read',
  'assets.upload',
  'brand_brain.read',
  'brand_brain.chat',
  'analytics.read',
  'analytics.explain',
  'strategy.read',
  'strategy.manage',
] as const;

const SPENDING_ROUTES = [
  '/v1/content/generate',
  '/v1/content/tool',
  '/v1/creative/generate',
  '/v1/brand-brain/chat',
  '/v1/analytics/explain',
  '/v1/strategy/generate',
  '/v1/intelligence/content-gap',
] as const;

const QUOTE_ROUTES = ['/v1/content/quote', '/v1/content/tool/quote', '/v1/creative/quote'] as const;

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let server: Awaited<ReturnType<typeof buildServer>>;
let spenderToken: string;
let nonSpenderToken: string;

async function memberWithKeys(keys: readonly string[], label: string): Promise<string> {
  const run = randomUUID().slice(0, 8);
  const workspaceId = fixtures.a.workspaceId;
  /*
   * A CATALOGUE-LEVEL role (`workspaceId` null), like the system roles: the
   * session-scoped membership read that resolves a caller's grants reads roles
   * through that same visibility. No system role holds the feature keys without
   * `copilot.use` — which is the point of Q18 — so the test builds one.
   */
  const role = await platform.role.create({
    data: {
      workspaceId: null,
      key: `q18-test-${label}-${run}`,
      realm: 'WORKSPACE',
      nameEn: `Q18 ${label}`,
      nameAr: `Q18 ${label}`,
    },
  });
  const permissions = await platform.permission.findMany({ where: { key: { in: [...keys] } } });
  expect(permissions.length).toBe(keys.length);
  await platform.rolePermission.createMany({
    data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
  });
  const user = await platform.user.create({
    data: {
      email: `q18-${label}-${run}@example.local`,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      timezone: 'UTC',
    },
  });
  await platform.membership.create({
    data: {
      workspaceId,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE',
      acceptedAt: new Date(),
      brandScope: [],
    },
  });
  const token = `q18-${label}-${randomUUID()}`;
  await platform.customerSession.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(token),
      activeWorkspaceId: workspaceId,
      expiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000),
    },
  });
  return token;
}

async function post(url: string, token: string): Promise<number> {
  const response = await server.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: {},
  });
  return response.statusCode;
}

async function reservations(): Promise<number> {
  return platform.creditReservation.count({ where: { workspaceId: fixtures.a.workspaceId } });
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  spenderToken = await memberWithKeys([...FEATURE_KEYS, 'copilot.use'], 'spender');
  nonSpenderToken = await memberWithKeys(FEATURE_KEYS, 'non-spender');
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('Q18 — spending credits needs the feature key AND copilot.use', () => {
  it.each(SPENDING_ROUTES)('%s refuses a member without copilot.use with a 404', async (url) => {
    const before = await reservations();
    expect(await post(url, nonSpenderToken)).toBe(404);
    expect(await reservations()).toBe(before);
  });

  it.each(SPENDING_ROUTES)('%s lets a member with copilot.use past the gate', async (url) => {
    const before = await reservations();
    const status = await post(url, spenderToken);
    // Past the gate, the empty body is what refuses — never the 404 above,
    // and never a 401: the session is real.
    expect(status).not.toBe(404);
    expect(status).not.toBe(401);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(await reservations()).toBe(before);
  });

  it.each(QUOTE_ROUTES)('%s spends nothing and stays open without copilot.use', async (url) => {
    const status = await post(url, nonSpenderToken);
    expect(status).not.toBe(404);
    expect(status).not.toBe(401);
  });

  it('the same member is a real, resolvable session (the 404 is the permission)', async () => {
    // Without a feature key at all the answer is the same 404, so the session
    // itself is proven live by the quote routes above answering past the gate.
    expect(await post('/v1/content/quote', nonSpenderToken)).not.toBe(401);
  });
});
