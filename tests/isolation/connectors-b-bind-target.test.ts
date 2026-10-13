import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { QUOTA_FEATURES, createPlanQuota } from '@brandspace/entitlements';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  SocialOAuthService,
  SocialTokenVault,
  type ApplicationResolver,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import { META, recordedGraph } from '../support/meta-graph-fixtures';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  grantUnlimitedQuota,
  type IsolationFixtures,
} from './fixtures';

/**
 * CONNECTORS B — A FACEBOOK PAGE IS STORED WITH THE PAGE'S OWN TOKEN (D-533).
 *
 * The real Facebook adapter, answering from recorded Graph responses, through
 * the real OAuth service on real PostgreSQL: the person's grant lists their
 * Pages, the flow pauses for a choice, and the chosen Page's token — not the
 * person's — is what is sealed and stored. The person's token is never
 * written to a connection.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});
const REDIRECT = 'https://api.example.test/v1/social/callback/facebook';
const applications: ApplicationResolver = {
  async resolve() {
    return {
      appId: '900000000000001',
      clientSecret: 'test-only-app-secret',
      redirectUri: REDIRECT,
    };
  },
};

function service<T>(
  graph: ReturnType<typeof recordedGraph>,
  fn: (oauth: SocialOAuthService) => Promise<T>,
): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new SocialOAuthService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy,
          registry: createConnectorRegistry({ policy, environment: 'STAGING', fetch: graph.fetch }),
          vault,
          applications,
          quota: createPlanQuota({
            db,
            workspaceId: fixtures.a.workspaceId,
            environment: 'DEVELOPMENT',
            featureKey: QUOTA_FEATURES.socialAccounts,
            period: 'total',
          }),
        }),
      ),
    { prisma: app },
  ) as Promise<T>;
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parsePublishingPolicy({
    providers: {
      facebook: {
        enabled: true,
        scopes: ['pages_show_list', 'pages_manage_posts'],
        targetKind: 'page',
        apiVersion: 'v26.0',
      },
    },
  });
  await grantUnlimitedQuota(app, {
    workspaceId: fixtures.a.workspaceId,
    platformUserId: fixtures.platformUserId,
    featureKey: QUOTA_FEATURES.socialAccounts,
  });
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('connectors B · bindTarget — the Page’s token is the one stored', () => {
  it('two Pages: the flow pauses, the chosen Page is bound to its own token, the person’s is not kept', async () => {
    const graph = recordedGraph({
      'GET oauth/access_token': [{ body: META.shortToken }, { body: META.longToken }],
      'GET me': { body: META.me },
      'GET me/permissions': { body: META.permissions },
      'GET me/accounts': [{ body: META.accountsPage1 }, { body: META.accountsPage2 }],
      'GET 111000000000001': { body: META.pageToken },
    });
    const { state } = await service(graph, (oauth) =>
      oauth.start({
        provider: 'FACEBOOK',
        brandId: fixtures.a.brandId,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );
    const paused = await service(graph, (oauth) =>
      oauth.complete({ state, code: 'code-1', redirectUri: REDIRECT }),
    );
    if (paused.outcome !== 'selection_required') throw new Error('expected a choice of Page');
    expect(paused.targets.map((target) => target.displayName)).toEqual([
      'Test Bakery',
      'Test Florist',
    ]);

    const connection = await service(graph, (oauth) =>
      oauth.chooseTarget({
        selectionToken: paused.selectionToken,
        externalAccountId: '111000000000001',
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );
    expect(connection).toMatchObject({
      provider: 'FACEBOOK',
      externalAccountId: '111000000000001',
      displayName: 'Test Bakery',
      targetKind: 'page',
      tokenExpiresAt: null,
    });

    const stored = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialCredential.findMany({
          where: { socialConnectionId: connection.id, retiredAt: null },
        }),
      { prisma: app },
    );
    expect(stored).toHaveLength(1);
    const credential = stored[0]!;
    const material = await vault.open({
      ciphertext: credential.ciphertext,
      iv: credential.iv,
      authTag: credential.authTag,
      wrappedDataKey: credential.wrappedDataKey,
      keyProvider: credential.keyProvider,
      keyId: credential.keyId,
      algorithm: 'AES-256-GCM',
      encryptionContext: credential.encryptionContext,
      maskedHint: credential.maskedHint,
      fingerprint: credential.fingerprint,
    });
    expect(material).toEqual({ accessToken: META.pageToken.access_token, refreshToken: null });
    // The Page token was asked for with the person's long-lived token, once.
    const bind = graph.calls.filter((call) => call.url.pathname.endsWith('/111000000000001'));
    expect(bind).toHaveLength(1);
    expect(bind[0]!.headers['authorization']).toBe(`Bearer ${META.longToken.access_token}`);
  });
});
