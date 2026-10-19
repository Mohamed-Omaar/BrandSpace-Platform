import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { withAiAppToken, withoutTenantContext, withWorkspace } from '@brandspace/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * D-566 — CONNECTED AI APPS: THE FIVE TABLES, AGAINST REAL POSTGRESQL.
 *
 *   - `ai_app_client` (global): the tenant role reads it and cannot write it;
 *   - `ai_app_connection`, `ai_app_authorization_code`, `ai_app_token`,
 *     `ai_app_rate_window` (tenant): a workspace sees only its own rows, cannot
 *     write into another workspace, and a code or token can never point at
 *     another workspace's connection (composite foreign keys);
 *   - with no workspace context, a token or code is visible ONLY to the caller
 *     holding its hash, read-only, and only that one row;
 *   - the database refuses what the application must never write: an unhashed
 *     token, an over-long lifetime, an unknown scope, a non-https redirect.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const RESOURCE = 'https://api.example.test/mcp';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

interface Seeded {
  readonly clientId: string;
  readonly connectionId: string;
  readonly tokenHash: string;
  readonly tokenId: string;
  readonly codeHash: string;
}
let seededA: Seeded;
let seededB: Seeded;

async function seed(workspaceId: string, userId: string): Promise<Seeded> {
  const client = await platform.aiAppClient.create({
    data: {
      clientId: `bsp_cli_${randomBytes(24).toString('base64url')}`,
      clientName: 'Fixture AI app',
      redirectUris: ['https://client.example.test/callback'],
    },
  });
  const connection = await platform.aiAppConnection.create({
    data: {
      workspaceId,
      userId,
      clientId: client.id,
      scopes: ['brandspace.read', 'brandspace.write', 'offline_access'],
    },
  });
  const tokenHash = sha(`token-${randomUUID()}`);
  const now = new Date();
  const token = await platform.aiAppToken.create({
    data: {
      workspaceId,
      connectionId: connection.id,
      kind: 'ACCESS',
      tokenHash,
      resource: RESOURCE,
      scopes: ['brandspace.read'],
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3600_000),
    },
  });
  const codeHash = sha(`code-${randomUUID()}`);
  await platform.aiAppAuthorizationCode.create({
    data: {
      workspaceId,
      connectionId: connection.id,
      codeHash,
      codeChallenge: CHALLENGE,
      redirectUri: 'https://client.example.test/callback',
      resource: RESOURCE,
      scopes: ['brandspace.read'],
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    },
  });
  await platform.aiAppRateWindow.create({
    data: { workspaceId, connectionId: connection.id, windowStart: now, count: 1 },
  });
  return {
    clientId: client.id,
    connectionId: connection.id,
    tokenHash,
    tokenId: token.id,
    codeHash,
  };
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  seededA = await seed(fixtures.a.workspaceId, fixtures.a.userId);
  seededB = await seed(fixtures.b.workspaceId, fixtures.b.userId);
}, 90_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

async function refusal(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
}

describe('D-566 · RLS is forced on all five tables', () => {
  it('the database says so', async () => {
    const rows = await platform.$queryRaw<{ relname: string; forced: boolean }[]>`
      SELECT relname, relrowsecurity AND relforcerowsecurity AS forced
        FROM pg_class
       WHERE relname IN ('ai_app_client', 'ai_app_connection', 'ai_app_authorization_code',
                         'ai_app_token', 'ai_app_rate_window')
         AND relnamespace = 'public'::regnamespace
       ORDER BY relname`;
    expect(rows).toEqual([
      { relname: 'ai_app_authorization_code', forced: true },
      { relname: 'ai_app_client', forced: true },
      { relname: 'ai_app_connection', forced: true },
      { relname: 'ai_app_rate_window', forced: true },
      { relname: 'ai_app_token', forced: true },
    ]);
  });
});

describe('D-566 · ai_app_client — read by the tenant role, never written by it', () => {
  it('reads the registry (the consent screen names the app)', async () => {
    const found = await withWorkspace(
      fixtures.a.workspaceId,
      (db) => db.aiAppClient.findUnique({ where: { id: seededB.clientId } }),
      { prisma: app },
    );
    expect(found?.clientName).toBe('Fixture AI app');
  });

  it('cannot insert, update or delete a client', async () => {
    for (const statement of [
      `INSERT INTO "ai_app_client" ("id","clientId","clientName","redirectUris") VALUES (gen_random_uuid(), 'bsp_cli_${'x'.repeat(40)}', 'Evil', ARRAY['https://evil.test/cb'])`,
      `UPDATE "ai_app_client" SET "clientName" = 'Renamed'`,
      `DELETE FROM "ai_app_client"`,
    ]) {
      const result = await refusal(() =>
        withWorkspace(fixtures.a.workspaceId, (db) => db.$executeRawUnsafe(statement), {
          prisma: app,
        }),
      );
      expect(result, statement).toMatch(/permission denied/i);
    }
  });
});

describe('D-566 · the four tenant tables — one workspace only', () => {
  it('workspace A sees its own connection, codes, tokens and windows, and none of B', async () => {
    const seen = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => ({
        connections: await db.aiAppConnection.findMany({ select: { id: true } }),
        codes: await db.aiAppAuthorizationCode.findMany({ select: { connectionId: true } }),
        tokens: await db.aiAppToken.findMany({ select: { connectionId: true } }),
        windows: await db.aiAppRateWindow.findMany({ select: { connectionId: true } }),
        countB: await db.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "ai_app_token" WHERE "connectionId" = '${seededB.connectionId}'`,
        ),
      }),
      { prisma: app },
    );
    const ids = (rows: { id?: string; connectionId?: string }[]) =>
      new Set(rows.map((row) => row.id ?? row.connectionId));
    for (const rows of [seen.connections, seen.codes, seen.tokens, seen.windows]) {
      expect(ids(rows).has(seededA.connectionId)).toBe(true);
      expect(ids(rows).has(seededB.connectionId)).toBe(false);
    }
    expect(Number(seen.countB[0]?.n)).toBe(0);
  });

  it('cannot revoke, or write into, another workspace', async () => {
    const changed = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        db.aiAppConnection.updateMany({
          where: { id: seededB.connectionId },
          data: { status: 'REVOKED', revokedAt: new Date() },
        }),
      { prisma: app },
    );
    expect(changed.count).toBe(0);
    const inserted = await refusal(() =>
      withWorkspace(
        fixtures.a.workspaceId,
        (db) =>
          db.aiAppConnection.create({
            data: {
              workspaceId: fixtures.b.workspaceId,
              userId: fixtures.b.userId,
              clientId: seededB.clientId,
              scopes: ['brandspace.read'],
            },
          }),
        { prisma: app },
      ),
    );
    expect(inserted).toMatch(/row-level security/i);
  });

  it('a token can never point at another workspace connection (composite key)', async () => {
    const now = new Date();
    const result = await refusal(() =>
      platform.aiAppToken.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          connectionId: seededB.connectionId,
          kind: 'ACCESS',
          tokenHash: sha(randomUUID()),
          resource: RESOURCE,
          scopes: ['brandspace.read'],
          createdAt: now,
          expiresAt: new Date(now.getTime() + 60_000),
        },
      }),
    );
    expect(result).toMatch(/ai_app_token_connection_fkey|Foreign key constraint/i);
  });

  it('a rotated token can never point at a successor in another workspace (D-112, D-568)', async () => {
    const now = new Date();
    const refresh = (workspaceId: string, connectionId: string, replacedById?: string) =>
      platform.aiAppToken.create({
        data: {
          workspaceId,
          connectionId,
          kind: 'REFRESH',
          tokenHash: sha(randomUUID()),
          resource: RESOURCE,
          scopes: ['brandspace.read', 'offline_access'],
          createdAt: now,
          expiresAt: new Date(now.getTime() + 86_400_000),
          ...(replacedById ? { replacedById } : {}),
        },
      });
    // Workspace B's token as A's successor: refused by the database itself.
    expect(
      await refusal(() => refresh(fixtures.a.workspaceId, seededA.connectionId, seededB.tokenId)),
    ).toMatch(/ai_app_token_replaced_fkey|Foreign key constraint/i);

    // A successor in the same workspace is accepted; deleting it clears only
    // the link, so the old row (and the reuse check) stays.
    const successor = await refresh(fixtures.a.workspaceId, seededA.connectionId);
    const old = await refresh(fixtures.a.workspaceId, seededA.connectionId, successor.id);
    await platform.aiAppToken.delete({ where: { id: successor.id } });
    const after = await platform.aiAppToken.findUniqueOrThrow({ where: { id: old.id } });
    expect(after.replacedById).toBeNull();
    expect(after.workspaceId).toBe(fixtures.a.workspaceId);
  });
});

describe('D-566 · the hash lookup — one row, read-only, only for the holder', () => {
  it('finds exactly the token whose hash is held, across workspaces, and nothing else', async () => {
    const found = await withAiAppToken(
      seededB.tokenHash,
      async (db) => ({
        all: await db.aiAppToken.findMany({ select: { id: true } }),
        codes: await db.aiAppAuthorizationCode.findMany({ select: { id: true } }),
        connections: await db.aiAppConnection.findMany({ select: { id: true } }),
      }),
      { prisma: app },
    );
    expect(found.all.map((row) => row.id)).toEqual([seededB.tokenId]);
    // The lookup grants the token row, not the connection behind it, and no code.
    expect(found.codes).toEqual([]);
    expect(found.connections).toEqual([]);
  });

  it('finds exactly the code whose hash is held', async () => {
    const found = await withAiAppToken(
      seededA.codeHash,
      (db) => db.aiAppAuthorizationCode.findMany({ select: { connectionId: true } }),
      { prisma: app },
    );
    expect(found).toEqual([{ connectionId: seededA.connectionId }]);
  });

  it('is read-only: the holder cannot revoke or rewrite the row it can see', async () => {
    const changed = await withAiAppToken(
      seededB.tokenHash,
      (db) =>
        db.aiAppToken.updateMany({
          where: { id: seededB.tokenId },
          data: { revokedAt: new Date() },
        }),
      { prisma: app },
    );
    expect(changed.count).toBe(0);
  });

  it('without a hash, or inside a workspace, the lookup grants nothing', async () => {
    const none = await withoutTenantContext((db) => db.aiAppToken.count(), { prisma: app });
    expect(none).toBe(0);
    const insideA = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        await db.$executeRaw`SELECT set_config('app.ai_app_token_hash', ${seededB.tokenHash}, true)`;
        return db.aiAppToken.findMany({ where: { tokenHash: seededB.tokenHash } });
      },
      { prisma: app },
    );
    expect(insideA).toEqual([]);
  });

  it('refuses a value that is not a hash before it reaches the database', async () => {
    expect(
      await refusal(() => withAiAppToken('bsp_at_raw-token', async () => 1, { prisma: app })),
    ).toMatch(/Invalid token scope/);
  });
});

describe('D-566 · what the database refuses', () => {
  const base = () => {
    const now = new Date();
    return {
      workspaceId: fixtures.a.workspaceId,
      connectionId: seededA.connectionId,
      kind: 'ACCESS' as const,
      tokenHash: sha(randomUUID()),
      resource: RESOURCE,
      scopes: ['brandspace.read'],
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    };
  };

  it('an unhashed token, an unknown scope, a lifetime over 90 days, a successor on an access token', async () => {
    expect(
      await refusal(() =>
        platform.aiAppToken.create({ data: { ...base(), tokenHash: 'bsp_at_x' } }),
      ),
    ).toMatch(/ai_app_token_hash_shape/);
    expect(
      await refusal(() =>
        platform.aiAppToken.create({ data: { ...base(), scopes: ['brandspace.admin'] } }),
      ),
    ).toMatch(/ai_app_token_scopes_known/);
    const long = base();
    expect(
      await refusal(() =>
        platform.aiAppToken.create({
          data: { ...long, expiresAt: new Date(long.createdAt.getTime() + 91 * 86_400_000) },
        }),
      ),
    ).toMatch(/ai_app_token_lifetime/);
    expect(
      await refusal(() =>
        platform.aiAppToken.create({ data: { ...base(), replacedById: seededA.tokenId } }),
      ),
    ).toMatch(/ai_app_token_replaced_kind/);
  });

  it('a code that lives over ten minutes, a malformed challenge, a plain-http redirect', async () => {
    const now = new Date();
    const code = {
      workspaceId: fixtures.a.workspaceId,
      connectionId: seededA.connectionId,
      codeHash: sha(randomUUID()),
      codeChallenge: CHALLENGE,
      redirectUri: 'https://client.example.test/callback',
      resource: RESOURCE,
      scopes: ['brandspace.read'],
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    };
    expect(
      await refusal(() =>
        platform.aiAppAuthorizationCode.create({
          data: { ...code, expiresAt: new Date(now.getTime() + 11 * 60_000) },
        }),
      ),
    ).toMatch(/ai_app_authorization_code_lifetime/);
    expect(
      await refusal(() =>
        platform.aiAppAuthorizationCode.create({ data: { ...code, codeChallenge: 'plain' } }),
      ),
    ).toMatch(/ai_app_authorization_code_challenge_shape/);
    expect(
      await refusal(() =>
        platform.aiAppAuthorizationCode.create({
          data: { ...code, redirectUri: 'http://evil.example.test/cb' },
        }),
      ),
    ).toMatch(/ai_app_authorization_code_redirect_shape/);
    // Loopback on any port is allowed (Claude Code, local MCP clients).
    expect(
      await refusal(() =>
        platform.aiAppAuthorizationCode.create({
          data: { ...code, codeHash: sha(randomUUID()), redirectUri: 'http://127.0.0.1:53682/cb' },
        }),
      ),
    ).toBeNull();
  });

  it('a revoked connection always carries its time, and a malformed client id is refused', async () => {
    expect(
      await refusal(() =>
        platform.aiAppConnection.update({
          where: { id: seededA.connectionId },
          data: { status: 'REVOKED' },
        }),
      ),
    ).toMatch(/ai_app_connection_revoked_shape/);
    expect(
      await refusal(() =>
        platform.aiAppClient.create({
          data: { clientId: 'client-1', clientName: 'X', redirectUris: ['https://x.test/cb'] },
        }),
      ),
    ).toMatch(/ai_app_client_client_id_shape/);
  });
});
