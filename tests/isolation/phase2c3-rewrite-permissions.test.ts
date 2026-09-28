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
 * PHASE 2C-3 (D10) — "Rewrite with the new fact" / "without this fact" is the
 * ordinary Studio tool route, `/v1/content/tool` with `refresh_facts`, and it
 * needs BOTH `content.edit` and `copilot.use` — proven through the real HTTP
 * handler, as the Q18 suite proves the spending routes.
 *
 * Each member is refused at the gate with the same 404 a genuine miss gets
 * when either key is missing; with both, the request passes the gate and the
 * rewrite of a variant that does not exist is the ordinary not-found — never a
 * reservation, never a charge. The quote route stays on `content.read`.
 */

const REWRITE = (variantId: string) => ({
  variantId,
  tool: 'refresh_facts',
  idempotencyKey: `refresh-${randomUUID()}`,
});

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let server: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<'both' | 'editOnly' | 'copilotOnly', string> = {
  both: '',
  editOnly: '',
  copilotOnly: '',
};

async function memberWithKeys(keys: readonly string[], label: string): Promise<string> {
  const run = randomUUID().slice(0, 8);
  const workspaceId = fixtures.a.workspaceId;
  const role = await platform.role.create({
    data: {
      workspaceId: null,
      key: `p2c3-rewrite-${label}-${run}`,
      realm: 'WORKSPACE',
      nameEn: `Rewrite ${label}`,
      nameAr: `Rewrite ${label}`,
    },
  });
  const permissions = await platform.permission.findMany({ where: { key: { in: [...keys] } } });
  expect(permissions.length).toBe(keys.length);
  await platform.rolePermission.createMany({
    data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
  });
  const user = await platform.user.create({
    data: {
      email: `p2c3-${label}-${run}@example.local`,
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
  const token = `p2c3-${label}-${randomUUID()}`;
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

async function post(url: string, token: string, payload: unknown): Promise<number> {
  const response = await server.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: payload as never,
  });
  return response.statusCode;
}

const reservations = () =>
  platform.creditReservation.count({ where: { workspaceId: fixtures.a.workspaceId } });

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  tokens.both = await memberWithKeys(
    ['workspace.read', 'content.read', 'content.edit', 'copilot.use'],
    'both',
  );
  tokens.editOnly = await memberWithKeys(
    ['workspace.read', 'content.read', 'content.edit'],
    'edit',
  );
  tokens.copilotOnly = await memberWithKeys(
    ['workspace.read', 'content.read', 'copilot.use'],
    'copilot',
  );
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('D10 Rewrite (refresh_facts) — content.edit AND copilot.use', () => {
  it('without copilot.use the rewrite is refused at the gate (404), nothing reserved', async () => {
    const before = await reservations();
    expect(
      await post('/v1/content/tool', tokens.editOnly, REWRITE(fixtures.a.contentVariantId)),
    ).toBe(404);
    expect(await reservations()).toBe(before);
  });

  it('without content.edit the rewrite is refused at the gate (404), nothing reserved', async () => {
    const before = await reservations();
    expect(
      await post('/v1/content/tool', tokens.copilotOnly, REWRITE(fixtures.a.contentVariantId)),
    ).toBe(404);
    expect(await reservations()).toBe(before);
  });

  it('with both, the request passes the gate and the schema accepts refresh_facts', async () => {
    const before = await reservations();
    // An empty body is the schema's refusal (422) — past the gate.
    expect(await post('/v1/content/tool', tokens.both, {})).toBe(422);
    // A well-formed refresh of a variant that does not exist is an ordinary miss.
    const status = await post('/v1/content/tool', tokens.both, REWRITE(randomUUID()));
    expect(status).not.toBe(422);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(await reservations()).toBe(before);
  });

  it('the price is quoted on the read key: the tool quote route admits content.read', async () => {
    const status = await post('/v1/content/tool/quote', tokens.editOnly, {});
    expect(status).not.toBe(404);
    expect(status).not.toBe(401);
  });
});
