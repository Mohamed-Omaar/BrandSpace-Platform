import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationService } from '@brandspace/config';
import { purgeAiApps } from '../../apps/api/src/ai-apps/sweep';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * D-566 — THE CONNECTED-AI-APPS PURGE, AGAINST REAL POSTGRESQL.
 *
 * Expired codes and tokens and old rate windows go; a revoked token is KEPT
 * until it expires (presenting a rotated refresh token again must still be
 * recognised as reuse); connections are never touched. And the owner's
 * addition to the approved plan: a registered app that never got a connection
 * is removed 30 days after registration, audited as a COUNT only — an app with
 * a connection, or a younger one, stays.
 */

let platform: PrismaClient;
let fixtures: IsolationFixtures;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const DAY = 86_400_000;

const client = (createdAt: Date) =>
  platform.aiAppClient.create({
    data: {
      clientId: `bsp_cli_${randomBytes(24).toString('base64url')}`,
      clientName: 'Sweep fixture app',
      redirectUris: ['https://client.example.test/callback'],
      createdAt,
    },
  });

beforeAll(async () => {
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(appRoleClient());
}, 90_000);

afterAll(async () => {
  await platform.$disconnect();
});

describe('D-566 · the purge', () => {
  it('removes apps never connected after 30 days, keeps the rest, and audits the count only', async () => {
    const now = new Date();
    const unused = await client(new Date(now.getTime() - 31 * DAY));
    const young = await client(new Date(now.getTime() - 5 * DAY));
    const connected = await client(new Date(now.getTime() - 40 * DAY));
    const connection = await platform.aiAppConnection.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: fixtures.a.userId,
        clientId: connected.id,
        scopes: ['brandspace.read'],
      },
    });
    // An expired code and token, a revoked-but-live token, and an old window.
    const created = new Date(now.getTime() - 3 * DAY);
    await platform.aiAppAuthorizationCode.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        connectionId: connection.id,
        codeHash: sha(randomUUID()),
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        redirectUri: 'https://client.example.test/callback',
        resource: 'https://api.example.test/mcp',
        scopes: ['brandspace.read'],
        createdAt: created,
        expiresAt: new Date(created.getTime() + 60_000),
      },
    });
    const expired = await platform.aiAppToken.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        connectionId: connection.id,
        kind: 'ACCESS',
        tokenHash: sha(randomUUID()),
        resource: 'https://api.example.test/mcp',
        scopes: ['brandspace.read'],
        createdAt: created,
        expiresAt: new Date(created.getTime() + 3_600_000),
      },
    });
    const revokedLive = await platform.aiAppToken.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        connectionId: connection.id,
        kind: 'REFRESH',
        tokenHash: sha(randomUUID()),
        resource: 'https://api.example.test/mcp',
        scopes: ['brandspace.read', 'offline_access'],
        createdAt: now,
        expiresAt: new Date(now.getTime() + 30 * DAY),
        revokedAt: now,
      },
    });
    await platform.aiAppRateWindow.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        connectionId: connection.id,
        windowStart: new Date(now.getTime() - 2 * DAY),
        count: 4,
      },
    });

    const result = await purgeAiApps({
      platform,
      configuration: new ConfigurationService({ prisma: platform, cacheTtlMs: 0 }),
      environment: 'DEVELOPMENT',
      now,
      batch: 5_000,
    });

    expect(result.clients).toBeGreaterThanOrEqual(1);
    expect(await platform.aiAppClient.findUnique({ where: { id: unused.id } })).toBeNull();
    expect(await platform.aiAppClient.findUnique({ where: { id: young.id } })).not.toBeNull();
    expect(await platform.aiAppClient.findUnique({ where: { id: connected.id } })).not.toBeNull();
    expect(
      await platform.aiAppConnection.findUnique({ where: { id: connection.id } }),
    ).not.toBeNull();
    expect(await platform.aiAppToken.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await platform.aiAppToken.findUnique({ where: { id: revokedLive.id } })).not.toBeNull();
    expect(
      await platform.aiAppAuthorizationCode.count({ where: { connectionId: connection.id } }),
    ).toBe(0);
    expect(await platform.aiAppRateWindow.count({ where: { connectionId: connection.id } })).toBe(
      0,
    );

    const audit = await platform.auditEvent.findFirstOrThrow({
      where: { action: 'ai_app.client.purged' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.workspaceId).toBeNull();
    expect(audit.actorType).toBe('SYSTEM');
    expect(audit.after).toEqual({ count: result.clients, olderThanDays: 30 });
    expect(JSON.stringify(audit)).not.toContain(unused.clientId);
    expect(JSON.stringify(audit)).not.toContain('Sweep fixture app');
  });

  it('runs twice harmlessly: the second pass removes nothing it already removed', async () => {
    const options = {
      platform,
      configuration: new ConfigurationService({ prisma: platform, cacheTtlMs: 0 }),
      environment: 'DEVELOPMENT' as const,
      now: new Date(),
      batch: 5_000,
    };
    await purgeAiApps(options);
    expect(await purgeAiApps(options)).toEqual({ codes: 0, tokens: 0, windows: 0, clients: 0 });
  });
});
