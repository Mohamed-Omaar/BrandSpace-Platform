import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type SocialProvider } from '@brandspace/database';
import { QUOTA_FEATURES, createPlanQuota } from '@brandspace/entitlements';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  SocialOAuthService,
  SocialTokenVault,
  subjectHash,
  type ApplicationResolver,
  type PublishingPolicy,
  type SubjectHasher,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  grantUnlimitedQuota,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * CONNECTORS A — W11 AND W10 ON THE OAUTH PATH, on real PostgreSQL.
 *
 * W11: the platform's callback arrives with no session, minutes after
 * "Connect". The person who started the flow must STILL be an active member,
 * with `integrations.manage`, and with the brand in their scope — checked from
 * the membership at the callback and again at the page choice, refused with
 * the one invalid-state sentence, and before any code is exchanged.
 *
 * W10: the granting platform user is kept only as `v<n>:` + a keyed hash.
 */

let app: PrismaClient;
let owner: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});
const REDIRECT = 'https://api.example.test/v1/social/callback/tiktok';
const applications: ApplicationResolver = {
  async resolve() {
    return {
      appId: 'test-only-app-id',
      clientSecret: 'test-only-client-secret-not-real',
      redirectUri: REDIRECT,
    };
  },
};

/** A visibly fake key; the version is part of what is stored. The redirect is the
 * one the resolver records at start, so every provider's callback uses it. */
const KEY = { version: 3, secret: 'test-only-subject-hash-key-not-real' };
const hasher: SubjectHasher = async (subjectId) => subjectHash(subjectId, KEY);

function service<T>(
  fn: (oauth: SocialOAuthService) => Promise<T>,
  subjectHasher?: SubjectHasher,
): Promise<T> {
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
          quota: createPlanQuota({
            db,
            workspaceId: fixtures.a.workspaceId,
            environment: 'DEVELOPMENT',
            featureKey: QUOTA_FEATURES.socialAccounts,
            period: 'total',
          }),
          ...(subjectHasher ? { subjectHasher } : {}),
        }),
      ),
    { prisma: app },
  ) as Promise<T>;
}

async function start(provider: SocialProvider): Promise<string> {
  const result = await service((oauth) =>
    oauth.start({
      provider,
      brandId: fixtures.a.brandId,
      actor: { userId: fixtures.a.userId, brandScope: [] },
    }),
  );
  return result.state;
}

/** The starter's membership, changed out from under the flow. */
async function changeMembership(data: Record<string, unknown>): Promise<void> {
  await owner.membership.update({ where: { id: fixtures.a.membershipId }, data });
}

let originalRoleId: string;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    const e = error as { code?: unknown; message?: unknown };
    return `${String(e.code)}:${String(e.message)}`;
  }
  throw new Error('the callback was ACCEPTED');
}

const connectionsOf = () =>
  withWorkspace(
    fixtures.a.workspaceId,
    async (db) => db.socialConnection.count({ where: { provider: 'TIKTOK' } }),
    { prisma: app },
  );

beforeAll(async () => {
  app = appRoleClient();
  owner = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parsePublishingPolicy({
    providers: {
      linkedin: { enabled: true, scopes: ['w_member_social'], targetKind: 'organization' },
      tiktok: { enabled: true, scopes: ['video.publish'], targetKind: 'creator_account' },
    },
  });
  await grantUnlimitedQuota(app, {
    workspaceId: fixtures.a.workspaceId,
    platformUserId: fixtures.platformUserId,
    featureKey: QUOTA_FEATURES.socialAccounts,
  });
  originalRoleId = (
    await owner.membership.findUniqueOrThrow({
      where: { id: fixtures.a.membershipId },
      select: { roleId: true },
    })
  ).roleId;
}, 60_000);

afterEach(async () => {
  await changeMembership({ status: 'ACTIVE', roleId: originalRoleId, brandScope: [] });
});

afterAll(async () => {
  await app?.$disconnect();
  await owner?.$disconnect();
});

describe('W11 — the starter must still be allowed when the platform calls back', () => {
  it('a member SUSPENDED since “Connect” creates nothing', async () => {
    const state = await start('TIKTOK');
    const before = await connectionsOf();
    await changeMembership({ status: 'SUSPENDED' });

    const refused = await refusal(
      service((oauth) => oauth.complete({ state, code: 'w11-suspended', redirectUri: REDIRECT })),
    );

    expect(refused.length).toBeGreaterThan(0);
    expect(await connectionsOf()).toBe(before);
  });

  it('a member whose role lost integrations.manage creates nothing', async () => {
    const state = await start('TIKTOK');
    const before = await connectionsOf();
    await changeMembership({ roleId: fixtures.a.customRoleId });

    await refusal(
      service((oauth) =>
        oauth.complete({ state, code: 'w11-no-permission', redirectUri: REDIRECT }),
      ),
    );

    expect(await connectionsOf()).toBe(before);
  });

  it('a member whose brand access no longer covers the brand creates nothing', async () => {
    const state = await start('TIKTOK');
    const before = await connectionsOf();
    await changeMembership({ brandScope: [randomUUID()] });

    await refusal(
      service((oauth) =>
        oauth.complete({ state, code: 'w11-out-of-scope', redirectUri: REDIRECT }),
      ),
    );

    expect(await connectionsOf()).toBe(before);
  });

  it('every refusal is the same sentence as a forged state', async () => {
    const forged = await refusal(
      service((oauth) =>
        oauth.complete({ state: 'forged-state', code: 'x', redirectUri: REDIRECT }),
      ),
    );
    const state = await start('TIKTOK');
    await changeMembership({ status: 'SUSPENDED' });
    const suspended = await refusal(
      service((oauth) => oauth.complete({ state, code: 'w11-same', redirectUri: REDIRECT })),
    );
    expect(suspended).toBe(forged);
  });

  it('the page choice is refused too, once the chooser lost the permission', async () => {
    const state = await start('LINKEDIN');
    const paused = await service((oauth) =>
      oauth.complete({ state, code: 'w11-choose', redirectUri: REDIRECT }),
    ).catch(() => null);
    // LinkedIn's mock offers two pages, so the flow pauses for a choice.
    if (!paused || paused.outcome !== 'selection_required') {
      throw new Error('expected a paused selection');
    }
    await changeMembership({ roleId: fixtures.a.customRoleId });

    await refusal(
      service((oauth) =>
        oauth.chooseTarget({
          selectionToken: paused.selectionToken,
          externalAccountId: paused.targets[0]!.externalAccountId,
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      ),
    );
  });
});

describe('W10 — the granting user is kept only as a keyed, versioned hash', () => {
  it('a connection stores v<version>: + HMAC-SHA256 of the platform user id, never the id', async () => {
    const state = await start('TIKTOK');
    const result = await service(
      (oauth) => oauth.complete({ state, code: 'w10-direct', redirectUri: REDIRECT }),
      hasher,
    );
    if (result.outcome !== 'connected') throw new Error('expected one target');

    const stored = result.connection.providerSubjectHash;
    expect(stored).toMatch(/^v3:[0-9a-f]{64}$/);
    // The mock reports `mock-subject_<sha256(provider|code)[0..16]>` as the user.
    const subjectId = `mock-subject_${createHash('sha256')
      .update(['TIKTOK', 'w10-direct'].join('|'))
      .digest('hex')
      .slice(0, 16)}`;
    expect(stored).toBe(`v3:${createHmac('sha256', KEY.secret).update(subjectId).digest('hex')}`);
    expect(JSON.stringify(result.connection)).not.toContain(subjectId);
  });

  it('through the page choice: carried on the authorization, written on the connection, then erased', async () => {
    const state = await start('LINKEDIN');
    const paused = await service(
      (oauth) =>
        oauth.complete({
          state,
          code: 'w10-choose',
          redirectUri: REDIRECT,
        }),
      hasher,
    );
    if (paused.outcome !== 'selection_required') throw new Error('expected a paused selection');
    const pending = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialOAuthState.findFirstOrThrow({
          where: { selectionConsumedAt: null, pendingSubjectHash: { not: null } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, pendingSubjectHash: true },
        }),
      { prisma: app },
    );
    expect(pending.pendingSubjectHash).toMatch(/^v3:[0-9a-f]{64}$/);

    const connection = await service((oauth) =>
      oauth.chooseTarget({
        selectionToken: paused.selectionToken,
        externalAccountId: paused.targets[0]!.externalAccountId,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );
    const after = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.socialOAuthState.findUniqueOrThrow({
          where: { id: pending.id },
          select: { pendingSubjectHash: true },
        }),
      { prisma: app },
    );

    expect(connection.providerSubjectHash).toBe(pending.pendingSubjectHash);
    expect(after.pendingSubjectHash).toBeNull();
  });

  it('with no key configured, nothing is stored — and the connection is still made', async () => {
    const state = await start('TIKTOK');
    const result = await service((oauth) =>
      oauth.complete({ state, code: 'w10-no-key', redirectUri: REDIRECT }),
    );
    if (result.outcome !== 'connected') throw new Error('expected one target');
    expect(result.connection.providerSubjectHash).toBeNull();
  });

  it('a rotated key keeps the old rows findable: each version yields its own prefix', () => {
    const v1 = subjectHash('user-1', { version: 1, secret: 'old' });
    const v2 = subjectHash('user-1', { version: 2, secret: 'new' });
    expect(v1.startsWith('v1:')).toBe(true);
    expect(v2.startsWith('v2:')).toBe(true);
    expect(v1.slice(3)).not.toBe(v2.slice(3));
  });
});
