import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { QUOTA_FEATURES, createPlanQuota } from '@brandspace/entitlements';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  SocialConnectionService,
  SocialOAuthService,
  SocialTokenVault,
  type AdapterApplication,
  type ApplicationResolver,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';

/**
 * CURRENT EXECUTION PHASE 3 — `limit.social_accounts` is a limit again.
 *
 * WHAT WAS WRONG. The dimension existed in the plan catalogue, in the quota
 * projection, on the Control Center's plan editor and in the downgrade impact
 * check. The configuration schema even said, beside the platform's own
 * `maxConnectionsPerWorkspace` ceiling, that "the plan limit lives in `plans`
 * and is enforced separately" — and it was enforced nowhere. Every workspace on
 * every plan could connect accounts without end.
 *
 * WHY THE ASSERTIONS ARE AT THE OAUTH SERVICE. That is the call site. Testing
 * `UsageService` again would prove what `quota-enforcement.test.ts` already
 * proves; what was missing was the CALL, and only a test that connects an
 * account can tell the difference.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});

const REDIRECT = 'https://api-staging.brandspace.cc/v1/social/callback/tiktok';

const applications: ApplicationResolver = {
  async resolve(): Promise<AdapterApplication> {
    return {
      appId: 'test-only-app-id',
      clientSecret: 'test-only-client-secret-not-real',
      redirectUri: REDIRECT,
    };
  },
};

/** TIKTOK only: its mock offers exactly one target, so a callback connects. */
function singleTargetPolicy(): PublishingPolicy {
  return parsePublishingPolicy({
    providers: {
      tiktok: {
        enabled: true,
        scopes: ['video.publish', 'video.upload'],
        targetKind: 'creator_account',
      },
    },
    // The PLATFORM ceiling, set high on purpose: this suite is about the PLAN
    // limit, and a refusal from the wrong ceiling would prove nothing.
    oauth: { stateTtlSeconds: 600, maxConnectionsPerWorkspace: 25 },
  });
}

function quotaFor(db: Parameters<typeof createPlanQuota>[0]['db'], workspaceId: string) {
  return createPlanQuota({
    db,
    workspaceId,
    environment: 'DEVELOPMENT',
    featureKey: QUOTA_FEATURES.socialAccounts,
    period: 'total',
  });
}

async function oauthIn<T>(fn: (service: SocialOAuthService) => Promise<T>): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new SocialOAuthService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy,
          registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
          vault,
          applications,
          quota: quotaFor(db, fixtures.a.workspaceId),
        }),
      ),
    { prisma: app },
  ) as Promise<T>;
}

async function connectionsIn<T>(fn: (service: SocialConnectionService) => Promise<T>): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(
        new SocialConnectionService({
          db,
          workspaceId: fixtures.a.workspaceId,
          registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
          vault,
          applications,
          quota: quotaFor(db, fixtures.a.workspaceId),
        }),
      ),
    { prisma: app },
  ) as Promise<T>;
}

/** Begin an authorization and return its opaque state. */
async function startFlow(): Promise<string> {
  const result = await oauthIn((service) =>
    service.start({
      provider: 'TIKTOK',
      brandId: fixtures.a.brandId,
      actor: { userId: fixtures.a.userId, brandScope: [] },
    }),
  );
  return result.state;
}

async function completeFlow(state: string): Promise<string> {
  const result = await oauthIn((service) =>
    service.complete({ state, code: `code-${randomUUID()}`, redirectUri: REDIRECT }),
  );
  if (result.outcome !== 'connected') throw new Error(`unexpected outcome ${result.outcome}`);
  return result.connection.id;
}

/**
 * How many accounts the plan counter says are in use.
 *
 * READ INSIDE THE WORKSPACE SCOPE, because `usage_counter` is tenant-owned:
 * the app role with no `app.workspace_id` set sees nothing at all, and a test
 * that read it unscoped would report zero for ever and pass whatever happened.
 */
async function counted(): Promise<number> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const row = await db.usageCounter.findFirst({
        where: { workspaceId: fixtures.a.workspaceId, featureKey: QUOTA_FEATURES.socialAccounts },
      });
      return row?.usedValue ?? 0;
    },
    { prisma: app },
  );
}

/** Connections that still occupy a slot. Scoped, for the same reason. */
async function liveConnections(): Promise<number> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      db.socialConnection.count({
        where: { workspaceId: fixtures.a.workspaceId, status: { not: 'REVOKED' } },
      }),
    { prisma: app },
  );
}

/** Grant the dimension with an explicit ceiling, the way an operator would. */
async function setCeiling(limitValue: number | null): Promise<void> {
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.workspaceOverride.deleteMany({
        where: {
          workspaceId: fixtures.a.workspaceId,
          featureKey: QUOTA_FEATURES.socialAccounts,
        },
      });
      await db.workspaceOverride.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          featureKey: QUOTA_FEATURES.socialAccounts,
          enabled: true,
          limitValue,
          reason: 'Phase 3 fixture: an explicit connected-account ceiling.',
          grantedByPlatformUserId: fixtures.platformUserId,
        },
      });
    },
    { prisma: app },
  );
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = singleTargetPolicy();

  /*
   * THE FIXTURE'S OWN CONNECTION IS RETIRED FIRST.
   *
   * `createIsolationFixtures` writes a row of every tenant-owned model so the
   * RLS suites have something to point at, and one of them is a live
   * `social_connection` — created directly, so it counts towards the platform
   * ceiling and does NOT appear in the plan counter. Starting a suite about a
   * ceiling with one account already connected and uncounted would measure the
   * fixture rather than the rule.
   */
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.socialConnection.updateMany({
        where: { workspaceId: fixtures.a.workspaceId },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
    },
    { prisma: app },
  );
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('the plan decides how many accounts a workspace may connect', () => {
  it('counts a connection against the plan, and refuses the one past the ceiling', async () => {
    await setCeiling(1);
    expect(await counted()).toBe(0);

    await completeFlow(await startFlow());
    expect(await counted()).toBe(1);

    // REFUSED BEFORE THE CONSENT SCREEN. Sending somebody to a provider and
    // then refusing the result is the worst possible order, so the ceiling is
    // read at `start` too.
    await expect(startFlow()).rejects.toThrow(/limit/i);
    expect(await counted()).toBe(1);
  });

  it('TWO CALLBACKS RACING FOR THE LAST SLOT: exactly one connects', async () => {
    await setCeiling(2);

    /*
     * BOTH AUTHORIZATIONS ARE STARTED FIRST, while there is still room, so both
     * pass the courtesy check at `start`. The ceiling is then reached by
     * whichever callback commits first, and the ATOMIC consumption at the
     * moment the connection is created is the only thing standing between the
     * second one and a connection the plan does not allow.
     *
     * A sequential "call it twice" would not test this: the second call would
     * read a counter the first had already moved.
     */
    const first = await startFlow();
    const second = await startFlow();
    await completeFlow(first);
    expect(await counted()).toBe(2);

    await expect(completeFlow(second)).rejects.toThrow(/limit/i);
    expect(await counted()).toBe(2);
    expect(await liveConnections()).toBe(2);
  });

  it('DISCONNECTING RETURNS THE SLOT — once, however many times it is asked', async () => {
    await setCeiling(null);
    const connectionId = await completeFlow(await startFlow());
    const before = await counted();

    await connectionsIn((service) =>
      service.disconnect({
        connectionId,
        actorUserId: fixtures.a.userId,
        brandScope: [],
      }),
    );
    expect(await counted()).toBe(before - 1);

    // A retried disconnection gives nothing back a second time: the refund is
    // keyed on the connection, so the movement happens exactly once.
    await connectionsIn((service) =>
      service.disconnect({
        connectionId,
        actorUserId: fixtures.a.userId,
        brandScope: [],
      }),
    ).catch(() => undefined);
    expect(await counted()).toBe(before - 1);
  });

  it('a returned slot can be used again, and takes a FRESH slot', async () => {
    await setCeiling(1);
    // Everything connected so far is disconnected, so the workspace is at zero.
    const live = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialConnection.findMany({
          where: { workspaceId: fixtures.a.workspaceId, status: { not: 'REVOKED' } },
          select: { id: true },
        }),
      { prisma: app },
    );
    for (const connection of live) {
      await connectionsIn((service) =>
        service.disconnect({
          connectionId: connection.id,
          actorUserId: fixtures.a.userId,
          brandScope: [],
        }),
      );
    }
    expect(await counted()).toBe(0);

    // A reconnection is a NEW slot, not a replay of a spent key. Keying the
    // consumption on the provider's account id would have made this free.
    await completeFlow(await startFlow());
    expect(await counted()).toBe(1);
  });

  it('A CEILING OF ZERO IS NONE, NOT UNLIMITED', async () => {
    await setCeiling(0);
    await expect(startFlow()).rejects.toThrow(/limit/i);
  });
});
