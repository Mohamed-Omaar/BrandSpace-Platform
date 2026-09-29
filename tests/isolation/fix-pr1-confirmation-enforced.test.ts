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
 * FIX PR 1 · F4 (D-411) — A HIGH-IMPACT ROUTE HOLDS ITS CONFIRMATION ON THE
 * SERVER, through the real HTTP handlers.
 *
 * Disconnect and pack checkout declared `confirmation: 'required'`, and the
 * declaration was metadata: the two steps lived only in the dashboard (B-9,
 * B-10). The API is public and a customer holds their own session, so one
 * request disconnected an account or opened a checkout. Both now require
 * `confirm: true` in the body — the mechanism subscription cancel already used
 * — and refuse without it before anything happens.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let server: Awaited<ReturnType<typeof buildServer>>;
let token: string;

async function managerToken(): Promise<string> {
  const run = randomUUID().slice(0, 8);
  const workspaceId = fixtures.a.workspaceId;
  // A catalogue-level role holding exactly the two keys under test, the way the
  // Q18 suite builds one: the session's grants are read through that visibility.
  const role = await platform.role.create({
    data: {
      workspaceId: null,
      key: `f4-test-${run}`,
      realm: 'WORKSPACE',
      nameEn: 'F4 manager',
      nameAr: 'F4 manager',
    },
  });
  const keys = ['workspace.read', 'integrations.manage', 'billing.read', 'billing.manage'];
  const permissions = await platform.permission.findMany({ where: { key: { in: keys } } });
  expect(permissions.length).toBe(keys.length);
  await platform.rolePermission.createMany({
    data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
  });
  const user = await platform.user.create({
    data: {
      email: `f4-${run}@example.local`,
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
  const secret = `f4-${randomUUID()}`;
  await platform.customerSession.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(secret),
      activeWorkspaceId: workspaceId,
      expiresAt: new Date(Date.now() + 3_600_000),
      absoluteExpiresAt: new Date(Date.now() + 7_200_000),
    },
  });
  return secret;
}

/** A connection of this suite's own, so revoking it disturbs nobody else's. */
async function freshConnection(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const connection = await platform.socialConnection.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      provider: 'LINKEDIN',
      externalAccountId: `f4-${suffix}`,
      displayName: `F4 ${suffix}`,
      targetKind: 'organization',
      status: 'ACTIVE',
      grantedScopes: ['w_member_social'],
      connectedByUserId: fixtures.a.userId,
      connectedAt: new Date(),
    },
  });
  return connection.id;
}

async function post(url: string, payload?: unknown): Promise<number> {
  const response = await server.inject({
    method: 'POST',
    url,
    // No body means no content type — the way a bare scripted POST arrives —
    // so the ROUTE's own refusal is what answers, not the JSON parser's.
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return response.statusCode;
}

const connectionStatus = async (id: string) =>
  (await platform.socialConnection.findUniqueOrThrow({ where: { id } })).status;
const disconnectEvents = (id: string) =>
  platform.auditEvent.count({
    where: { action: 'social.connection.disconnected', resourceId: id },
  });
const checkoutSessions = () =>
  platform.checkoutSession.count({ where: { workspaceId: fixtures.a.workspaceId } });

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  token = await managerToken();
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('F4 · disconnect needs confirm: true on the server', () => {
  it.each([
    ['no body at all', undefined],
    ['an empty body', {}],
    ['confirm: false', { confirm: false }],
    ['confirm as a string', { confirm: 'true' }],
  ])('%s is refused with 422, and the account stays connected', async (_label, payload) => {
    const id = await freshConnection();
    expect(await post(`/v1/social/connections/${id}/disconnect`, payload)).toBe(422);
    expect(await connectionStatus(id)).toBe('ACTIVE');
    expect(await disconnectEvents(id)).toBe(0);
  });

  it('confirm: true disconnects, exactly as the dashboard asks for it', async () => {
    const id = await freshConnection();
    expect(await post(`/v1/social/connections/${id}/disconnect`, { confirm: true })).toBe(200);
    expect(await connectionStatus(id)).toBe('REVOKED');
    expect(await disconnectEvents(id)).toBe(1);
  });

  it('an account of another workspace is still the identical 404, confirmed or not', async () => {
    const other = await platform.socialConnection.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        brandId: fixtures.b.brandId,
        provider: 'LINKEDIN',
        externalAccountId: `f4-b-${randomUUID().slice(0, 8)}`,
        displayName: 'F4 other',
        targetKind: 'organization',
        status: 'ACTIVE',
        grantedScopes: ['w_member_social'],
        connectedByUserId: fixtures.b.userId,
        connectedAt: new Date(),
      },
    });
    expect(await post(`/v1/social/connections/${other.id}/disconnect`, { confirm: true })).toBe(
      404,
    );
    expect(await connectionStatus(other.id)).toBe('ACTIVE');
  });
});

describe('F4 · pack checkout needs confirm: true on the server', () => {
  it('without confirm it is refused with 422 before any checkout is opened', async () => {
    const before = await checkoutSessions();
    expect(
      await post('/v1/commerce/checkout/pack', {
        packKey: 'any-pack',
        idempotencyKey: `f4-${randomUUID()}`,
        locale: 'en',
      }),
    ).toBe(422);
    expect(await checkoutSessions()).toBe(before);
  });
  // The confirmed purchase is exercised end to end by tests/e2e/phase9-commerce.spec.ts,
  // which clicks through the dialog: that is the dashboard's two steps still working.
});
