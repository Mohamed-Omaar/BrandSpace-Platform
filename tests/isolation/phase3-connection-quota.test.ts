import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { QUOTA_FEATURES, createTotalResourceQuota } from '@brandspace/entitlements';
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

/**
 * THE ADAPTER THE PRODUCT BUILDS, not one assembled here.
 *
 * An earlier version of this file constructed its own `createPlanQuota` with a
 * feature key and a period and NO live population — so every assertion below
 * ran against a quota that only knew what the counter had been told, which is
 * the defect this suite exists to catch. `createTotalResourceQuota` is the only
 * way to build one, and it carries the population with the dimension.
 */
function quotaFor(db: TenantScopedClient, workspaceId: string) {
  return createTotalResourceQuota({
    db,
    workspaceId,
    environment: 'DEVELOPMENT',
    dimension: 'socialAccounts',
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
   * THE FIXTURE'S OWN CONNECTION IS LEFT EXACTLY WHERE IT IS.
   *
   * `createIsolationFixtures` writes a row of every tenant-owned model so the
   * RLS suites have something to point at, and one of them is a live
   * `social_connection` created DIRECTLY — so it occupies a slot and has never
   * been near the plan counter. That is not an inconvenience to be tidied away
   * before the real assertions; it is precisely the production state this
   * suite exists to test. An earlier version of this file revoked it in
   * `beforeAll`, which made every assertion below start from a counter that
   * happened to agree with reality and proved nothing about one that does not.
   */
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('the plan decides how many accounts a workspace may connect', () => {
  it('B — A CONNECTION MADE BEFORE THE DIMENSION EXISTED IS STILL COUNTED', async () => {
    await setCeiling(null);
    const historical = await liveConnections();
    // The fixture's own connection, made directly and never counted.
    expect(historical).toBeGreaterThanOrEqual(1);
    expect(await counted()).toBe(0);

    await completeFlow(await startFlow());

    // NOT 1. The counter reflects everything that occupies a slot, which is
    // what a `total` quota is supposed to mean.
    expect(await counted()).toBe(historical + 1);
    expect(await liveConnections()).toBe(historical + 1);
  });

  it('A — TWO CALLBACKS RACING FOR THE LAST SLOT, WITH HISTORY IN THE WAY', async () => {
    const live = await liveConnections();
    // One slot left, and the rows already there are what fills the rest of it.
    await setCeiling(live + 1);

    /*
     * BOTH AUTHORIZATIONS ARE STARTED FIRST, while there is still room, so both
     * pass the courtesy check at `start`. Then both callbacks are completed at
     * once: the atomic admission — the counter row's lock, the live count taken
     * behind it, and the limit in the same statement — is the only thing
     * standing between the second one and a connection the plan does not allow.
     *
     * A sequential "call it twice" would not test this, and neither would a
     * counter that had never heard of the rows already there: with a counter of
     * zero both callbacks would have seen 0 then 1 against a limit of live + 1
     * and BOTH would have been admitted.
     */
    const first = await startFlow();
    const second = await startFlow();
    const outcomes = await Promise.allSettled([completeFlow(first), completeFlow(second)]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(/limit/i);

    expect(await liveConnections()).toBe(live + 1);
    expect(await counted()).toBe(live + 1);
  });

  it('refuses the one past the ceiling, before the consent screen', async () => {
    const live = await liveConnections();
    await setCeiling(live);
    await expect(startFlow()).rejects.toThrow(/limit/i);
    expect(await liveConnections()).toBe(live);
  });

  it('C — DISCONNECTING A CONNECTION THE COUNTER NEVER KNEW ABOUT DOES NOT CORRUPT IT', async () => {
    await setCeiling(null);
    /*
     * The fixture's own connection: made directly, never consumed, and now
     * disconnected. The refund finds nothing of its own to give back, and the
     * counter must neither go negative nor start admitting past the ceiling.
     */
    const historical = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialConnection.findFirstOrThrow({
          where: { workspaceId: fixtures.a.workspaceId, status: { not: 'REVOKED' } },
          orderBy: { connectedAt: 'asc' },
          select: { id: true },
        }),
      { prisma: app },
    );

    await connectionsIn((service) =>
      service.disconnect({
        connectionId: historical.id,
        actorUserId: fixtures.a.userId,
        brandScope: [],
      }),
    );

    const live = await liveConnections();
    expect(await counted()).toBeGreaterThanOrEqual(0);

    // AND THE CEILING STILL HOLDS AGAINST WHAT EXISTS. One slot left by the
    // live count is one slot, whatever the counter happens to say.
    await setCeiling(live + 1);
    await completeFlow(await startFlow());
    expect(await counted()).toBe(live + 1);
    await expect(startFlow()).rejects.toThrow(/limit/i);
  });

  it('D — CONSUMING AGAIN DOES NOT DOUBLE-COUNT WHAT IS ALREADY THERE', async () => {
    await setCeiling(null);
    const before = await liveConnections();
    expect(await counted()).toBe(before);

    await completeFlow(await startFlow());
    expect(await counted()).toBe(before + 1);

    await completeFlow(await startFlow());
    // before + 2, not (before + 1) + (before + 2): the greater of the counter
    // and the live population is one of them, never their sum.
    expect(await counted()).toBe(before + 2);
    expect(await counted()).toBe(await liveConnections());
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
    await setCeiling(null);
    const live = await liveConnections();
    const connectionId = await completeFlow(await startFlow());
    expect(await counted()).toBe(live + 1);

    await connectionsIn((service) =>
      service.disconnect({
        connectionId,
        actorUserId: fixtures.a.userId,
        brandScope: [],
      }),
    );
    expect(await counted()).toBe(live);

    // A reconnection is a NEW slot, not a replay of a spent key. Keying the
    // consumption on the provider's account id would have made this free.
    await completeFlow(await startFlow());
    expect(await counted()).toBe(live + 1);
  });

  it('A CEILING OF ZERO IS NONE, NOT UNLIMITED', async () => {
    await setCeiling(0);
    await expect(startFlow()).rejects.toThrow(/limit/i);
  });
});
