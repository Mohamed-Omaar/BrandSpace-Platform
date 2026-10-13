import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  SocialConnectionService,
  SocialTokenVault,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';

/**
 * CONNECTORS C — WHAT A TIKTOK ACCOUNT MAY POST (`postingOptions`), READ ONLY
 * INSIDE THE CALLER'S WORKSPACE AND BRANDS (CLAUDE.md §2.1).
 *
 * The Studio asks it for every TikTok account of the post's brand. Asked from
 * workspace A about B's account, or by a member whose brands do not include
 * the account's, the answer is the same not-found a missing id gets, and no
 * credential is opened.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});
const policy = parsePublishingPolicy({
  providers: { tiktok: { enabled: true, postKinds: ['video'], scopes: ['video.publish'] } },
});

function inWorkspace<T>(side: 'a' | 'b', fn: (db: TenantScopedClient) => Promise<T>) {
  return withWorkspace(fixtures[side].workspaceId, fn as never, { prisma: app }) as Promise<T>;
}

async function tiktokAccount(side: 'a' | 'b'): Promise<string> {
  const world = fixtures[side];
  return inWorkspace(side, async (db) => {
    const connection = await db.socialConnection.create({
      data: {
        workspaceId: world.workspaceId,
        brandId: world.brandId,
        provider: 'TIKTOK',
        externalAccountId: `tiktok-${randomUUID()}`,
        displayName: 'Creator',
        targetKind: 'profile',
        status: 'ACTIVE',
        grantedScopes: ['video.publish'],
        connectedByUserId: world.userId,
        connectedAt: new Date(),
      },
    });
    const sealed = await vault.seal({
      workspaceId: world.workspaceId,
      socialConnectionId: connection.id,
      version: 1,
      material: { accessToken: 'test-private-account-token', refreshToken: null },
    });
    await db.socialCredential.create({
      data: {
        workspaceId: world.workspaceId,
        socialConnectionId: connection.id,
        version: 1,
        ...sealed,
        hasRefreshToken: false,
      },
    });
    return connection.id;
  });
}

const ask = (side: 'a' | 'b', connectionId: string, brandScope: readonly string[]) =>
  inWorkspace(side, (db) =>
    new SocialConnectionService({
      db,
      workspaceId: fixtures[side].workspaceId,
      registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
      vault,
    }).postingOptions({ connectionId, brandScope }),
  );

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('connectors C · posting options are read in the caller’s workspace and brands only', () => {
  it('the owner of the account gets its options (the development connector’s, here)', async () => {
    const own = await tiktokAccount('a');
    const options = await ask('a', own, []);
    expect(options?.privacyLevels).toEqual([
      'FOLLOWER_OF_CREATOR',
      'MUTUAL_FOLLOW_FRIENDS',
      'SELF_ONLY',
    ]);
    expect(await ask('a', own, [fixtures.a.brandId])).not.toBeNull();
  });

  it('another workspace’s account is not found, exactly like a missing one', async () => {
    const theirs = await tiktokAccount('b');
    const missing = await ask('a', randomUUID(), []).catch((error: unknown) => error);
    const crossed = await ask('a', theirs, []).catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(Error);
    expect((crossed as { code?: string }).code).toBe((missing as { code?: string }).code);
  });

  it('a member whose brands do not include the account’s is not told about it', async () => {
    const own = await tiktokAccount('a');
    const outside = await ask('a', own, [randomUUID()]).catch((error: unknown) => error);
    const missing = await ask('a', randomUUID(), [randomUUID()]).catch((error: unknown) => error);
    expect(outside).toBeInstanceOf(Error);
    expect((outside as { code?: string }).code).toBe((missing as { code?: string }).code);
  });
});
