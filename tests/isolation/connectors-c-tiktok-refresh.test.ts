import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { QUOTA_FEATURES, createPlanQuota } from '@brandspace/entitlements';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  SocialOAuthService,
  SocialTokenVault,
  type ApplicationResolver,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import { ok, recordedTikTok, TIKTOK } from '../support/tiktok-fixtures';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';

/**
 * CONNECTORS C — TIKTOK REFRESH TOKENS ROTATE, AND THE NEW ONE IS STORED ON
 * EVERY REFRESH (D-505).
 *
 * The real TikTok adapter, answering from recorded responses, through the real
 * OAuth service on real PostgreSQL: each refresh seals what TikTok answered as
 * the next credential version and retires the one before, so the refresh token
 * in the vault is always the latest. When TikTok answers no new refresh token,
 * the one that worked is carried forward rather than lost.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});
const applications: ApplicationResolver = {
  async resolve() {
    return {
      appId: 'testclientkey0001',
      clientSecret: 'test-only-client-secret',
      redirectUri: 'https://api.example.test/v1/social/callback/tiktok',
    };
  },
};

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

function refresh(connectionId: string, answer: unknown) {
  const recorded = recordedTikTok({ 'oauth/token/': [ok(answer)] });
  return inA(async (db) => {
    const service = new SocialOAuthService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy,
      registry: createConnectorRegistry({
        policy,
        environment: 'STAGING',
        tiktokFetch: recorded.fetch,
      }),
      vault,
      applications,
      quota: createPlanQuota({
        db,
        workspaceId: fixtures.a.workspaceId,
        environment: 'DEVELOPMENT',
        featureKey: QUOTA_FEATURES.socialAccounts,
        period: 'total',
      }),
    });
    await service.refresh({ connectionId, brandScope: [] });
    return recorded.calls;
  });
}

async function credentials(connectionId: string) {
  return inA(async (db) => {
    const rows = await db.socialCredential.findMany({
      where: { socialConnectionId: connectionId },
      orderBy: { version: 'asc' },
    });
    return Promise.all(
      rows.map(async (row) => ({
        version: row.version,
        retired: row.retiredAt !== null,
        material: await vault.open({
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.authTag,
          wrappedDataKey: row.wrappedDataKey,
          keyProvider: row.keyProvider,
          keyId: row.keyId,
          algorithm: 'AES-256-GCM',
          encryptionContext: row.encryptionContext as never,
          maskedHint: row.maskedHint,
          fingerprint: row.fingerprint,
        }),
      })),
    );
  });
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parsePublishingPolicy({
    providers: {
      tiktok: {
        enabled: true,
        scopes: ['user.info.basic', 'video.publish'],
        postKinds: ['video'],
        apiVersion: 'v2',
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('connectors C · a TikTok refresh stores the rotated refresh token', () => {
  it('every refresh seals what TikTok answered as the next version; a missing one carries forward', async () => {
    const connectionId = await inA(async (db) => {
      const connection = await db.socialConnection.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          provider: 'TIKTOK',
          externalAccountId: `test-open-${randomUUID()}`,
          displayName: 'Creator',
          targetKind: 'profile',
          status: 'ACTIVE',
          grantedScopes: ['user.info.basic', 'video.publish'],
          connectedByUserId: fixtures.a.userId,
          connectedAt: new Date(),
          tokenExpiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const sealed = await vault.seal({
        workspaceId: fixtures.a.workspaceId,
        socialConnectionId: connection.id,
        version: 1,
        material: { accessToken: 'act.first', refreshToken: 'rft.first' },
      });
      await db.socialCredential.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          socialConnectionId: connection.id,
          version: 1,
          ...sealed,
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          hasRefreshToken: true,
        },
      });
      return connection.id;
    });

    const calls = await refresh(connectionId, TIKTOK.token('rft.rotated'));
    // TikTok was asked with the refresh token that was stored.
    expect(new URLSearchParams(String(calls[0]?.body)).get('refresh_token')).toBe('rft.first');

    // TikTok answers no refresh token this time: the rotated one stays.
    const second = await refresh(connectionId, TIKTOK.token(null));
    expect(new URLSearchParams(String(second[0]?.body)).get('refresh_token')).toBe('rft.rotated');

    const stored = await credentials(connectionId);
    expect(stored.map((row) => [row.version, row.retired, row.material.refreshToken])).toEqual([
      [1, true, 'rft.first'],
      [2, true, 'rft.rotated'],
      [3, false, 'rft.rotated'],
    ]);
    const status = await inA(async (db) =>
      db.socialConnection.findUniqueOrThrow({ where: { id: connectionId } }),
    );
    expect(status.status).toBe('ACTIVE');
    // TikTok's access token lasts 24 hours: the connection says so.
    expect(status.tokenExpiresAt!.getTime() - Date.now()).toBeGreaterThan(86_000 * 1_000);
  });
});
