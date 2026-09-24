import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { createTotalResourceQuota } from '@brandspace/entitlements';
import {
  createConnectorRegistry,
  parsePublishingPolicy,
  PublishPipelineService,
  publishIdempotencyKey,
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
 * PHASE 6 FINAL · D-277 §33, D-291 — RECONNECT, THEN RETRY.
 *
 * Two defects, one journey. Reconnecting an account whose connection was
 * still live (NEEDS_REAUTH) tried to create a second row and was refused by
 * `social_connection_one_live_per_account`, so "Reconnect" could not succeed;
 * and a post that failed on a broken account had no honest retry once the
 * account was fixed. Both are proven here against real PostgreSQL:
 *
 *   - the same account reconnects IN PLACE: one row, a new credential version,
 *     the old one retired, no second plan slot;
 *   - a failed post is retryable only through THAT account, renewed AFTER the
 *     failure, never for an indeterminate class, and never across a workspace
 *     or a brand scope.
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

function enabledPolicy(): PublishingPolicy {
  const capability = {
    enabled: true,
    postKinds: ['text'],
    maxBodyCharacters: 2_200,
    maxHashtags: 30,
    maxMediaItems: 10,
    supportsFirstComment: false,
    supportsDelete: false,
    supportsNativeScheduling: false,
    supportsPostLookup: true,
    scopes: ['w_member_social'],
    targetKind: 'organization',
  };
  return parsePublishingPolicy({
    providers: {
      tiktok: { ...capability, scopes: ['video.publish', 'video.upload'] },
      linkedin: capability,
    },
    oauth: { stateTtlSeconds: 600, maxConnectionsPerWorkspace: 50 },
  });
}

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

function pipelineIn<T>(
  workspaceId: string,
  fn: (pipeline: PublishPipelineService) => Promise<T>,
): Promise<T> {
  return withWorkspace(
    workspaceId,
    async (db) =>
      fn(
        new PublishPipelineService({
          db,
          workspaceId,
          policy,
          registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
          vault,
          approvals: {
            async policyForBrand() {
              return { requireApprovalBeforeScheduling: false };
            },
            async latestForItem() {
              return { status: 'APPROVED' };
            },
          },
        }),
      ),
    { prisma: app },
  ) as Promise<T>;
}

function oauthIn<T>(fn: (service: SocialOAuthService) => Promise<T>): Promise<T> {
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
          quota: createTotalResourceQuota({
            db,
            workspaceId: fixtures.a.workspaceId,
            environment: 'DEVELOPMENT',
            dimension: 'socialAccounts',
          }),
        }),
      ),
    { prisma: app },
  ) as Promise<T>;
}

/** A TikTok authorization completed with a chosen code: same code, same account. */
async function connectWith(code: string): Promise<string> {
  const { state } = await oauthIn((service) =>
    service.start({
      provider: 'TIKTOK',
      brandId: fixtures.a.brandId,
      actor: { userId: fixtures.a.userId, brandScope: [] },
    }),
  );
  const result = await oauthIn((service) =>
    service.complete({ state, code, redirectUri: REDIRECT }),
  );
  if (result.outcome !== 'connected') throw new Error(`unexpected outcome ${result.outcome}`);
  return result.connection.id;
}

const past = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** A LinkedIn connection in a chosen state, for the retry rules. */
async function connection(input: {
  externalAccountId: string;
  status: 'ACTIVE' | 'NEEDS_REAUTH' | 'REVOKED';
  connectedAt: Date;
}): Promise<string> {
  return (
    await inA((db) =>
      db.socialConnection.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          provider: 'LINKEDIN',
          externalAccountId: input.externalAccountId,
          displayName: 'Reconnect fixture',
          targetKind: 'organization',
          status: input.status,
          connectedAt: input.connectedAt,
          // A revoked row carries when (`social_connection_revoked_consistently`).
          ...(input.status === 'REVOKED' ? { revokedAt: past(30) } : {}),
        },
        select: { id: true },
      }),
    )
  ).id;
}

/** A job that FAILED on `connectionId` ten minutes ago. */
async function failedJob(connectionId: string, failureClass: string): Promise<string> {
  return (
    await inA((db) =>
      db.publishJob.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          calendarSlotId: fixtures.a.calendarSlotId,
          contentItemId: fixtures.a.contentItemId,
          contentVariantId: fixtures.a.contentVariantId,
          socialConnectionId: connectionId,
          provider: 'LINKEDIN',
          status: 'FAILED',
          failureClass: failureClass as never,
          idempotencyKey: `reconnect-${randomUUID()}`,
          scheduledAtUtc: past(20),
          maxAttempts: 5,
          nextAttemptAt: past(20),
          completedAt: past(10),
        },
        select: { id: true },
      }),
    )
  ).id;
}

const retry = (jobId: string, brandScope: readonly string[] = [], workspaceId?: string) =>
  pipelineIn(workspaceId ?? fixtures.a.workspaceId, (pipeline) =>
    pipeline.retryOnReconnectedAccount({ jobId, actorUserId: fixtures.a.userId, brandScope }),
  );
const retryable = (jobIds: string[]) =>
  pipelineIn(fixtures.a.workspaceId, (pipeline) => pipeline.reconnectedRetryable(jobIds));
const readJob = (jobId: string) =>
  inA((db) => db.publishJob.findFirstOrThrow({ where: { id: jobId } }));

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = enabledPolicy();
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('D-291 · the same account reconnects in place', () => {
  it('renews the live row instead of colliding with it', async () => {
    const code = `code-${randomUUID()}`;
    const first = await connectWith(code);
    await inA((db) =>
      db.socialConnection.update({
        where: { id: first },
        data: { status: 'NEEDS_REAUTH', lastFailureClass: 'AUTH_REVOKED' },
      }),
    );
    const live = () =>
      inA((db) =>
        db.socialConnection.count({
          where: { workspaceId: fixtures.a.workspaceId, status: { not: 'REVOKED' } },
        }),
      );
    const before = await live();

    // The same code yields the same account: this is "Reconnect".
    const second = await connectWith(code);

    expect(second).toBe(first);
    expect(await live()).toBe(before);
    const row = await inA((db) => db.socialConnection.findFirstOrThrow({ where: { id: first } }));
    expect(row.status).toBe('ACTIVE');
    expect(row.lastFailureClass).toBeNull();
    const credentials = await inA((db) =>
      db.socialCredential.findMany({
        where: { socialConnectionId: first },
        orderBy: { version: 'asc' },
      }),
    );
    expect(credentials.map((c) => c.version)).toEqual([1, 2]);
    expect(credentials[0]?.retiredAt).not.toBeNull();
    expect(credentials[1]?.retiredAt).toBeNull();
    const audit = await inA((db) =>
      db.auditEvent.count({
        where: { action: 'social.connection.reconnected', resourceId: first },
      }),
    );
    expect(audit).toBe(1);
  });
});

describe('D-291 · a failed post can be retried through its account, once fixed', () => {
  it('is not retryable while the account is still broken', async () => {
    const account = await connection({
      externalAccountId: `acct-${randomUUID()}`,
      status: 'NEEDS_REAUTH',
      connectedAt: past(60),
    });
    const job = await failedJob(account, 'AUTH_REVOKED');
    expect((await retryable([job])).has(job)).toBe(false);
    await expect(retry(job)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('after an in-place reconnection: queued again on the same account and key', async () => {
    const account = await connection({
      externalAccountId: `acct-${randomUUID()}`,
      status: 'NEEDS_REAUTH',
      connectedAt: past(60),
    });
    const job = await failedJob(account, 'AUTH_REVOKED');
    const key = (await readJob(job)).idempotencyKey;
    await inA((db) =>
      db.socialConnection.update({
        where: { id: account },
        data: { status: 'ACTIVE', connectedAt: new Date() },
      }),
    );

    expect((await retryable([job])).has(job)).toBe(true);
    await retry(job);
    const after = await readJob(job);
    expect(after.status).toBe('QUEUED');
    expect(after.failureClass).toBeNull();
    expect(after.socialConnectionId).toBe(account);
    expect(after.idempotencyKey).toBe(key);
    const audit = await inA((db) =>
      db.auditEvent.findFirst({
        where: { action: 'social.post.retry_requested', resourceId: job },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    expect(JSON.stringify(audit?.after)).toContain('reconnected_account');
  });

  it('after a disconnect and a fresh connection of the SAME account: re-bound, new key', async () => {
    const accountId = `acct-${randomUUID()}`;
    const old = await connection({
      externalAccountId: accountId,
      status: 'REVOKED',
      connectedAt: past(60),
    });
    const job = await failedJob(old, 'INSUFFICIENT_SCOPE');
    const fresh = await connection({
      externalAccountId: accountId,
      status: 'ACTIVE',
      connectedAt: new Date(),
    });

    await retry(job);
    const after = await readJob(job);
    expect(after.socialConnectionId).toBe(fresh);
    expect(after.idempotencyKey).toBe(
      publishIdempotencyKey({
        workspaceId: fixtures.a.workspaceId,
        calendarSlotId: fixtures.a.calendarSlotId,
        socialConnectionId: fresh,
        contentVariantId: fixtures.a.contentVariantId,
      }),
    );
  });

  it('never through ANOTHER account on the same platform', async () => {
    const old = await connection({
      externalAccountId: `acct-${randomUUID()}`,
      status: 'REVOKED',
      connectedAt: past(60),
    });
    const job = await failedJob(old, 'AUTH_REVOKED');
    await connection({
      externalAccountId: `acct-${randomUUID()}`,
      status: 'ACTIVE',
      connectedAt: new Date(),
    });
    expect((await retryable([job])).has(job)).toBe(false);
    await expect(retry(job)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('not when the account was healthy all along — nothing was renewed after the failure', async () => {
    const account = await connection({
      externalAccountId: `acct-${randomUUID()}`,
      status: 'ACTIVE',
      connectedAt: past(60),
    });
    const job = await failedJob(account, 'AUTH_EXPIRED');
    await expect(retry(job)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('never for an indeterminate failure, whatever happened to the account', async () => {
    const account = await connection({
      externalAccountId: `acct-${randomUUID()}`,
      status: 'ACTIVE',
      connectedAt: new Date(Date.now() + 1_000),
    });
    const job = await failedJob(account, 'TIMEOUT');
    await expect(retry(job)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('another workspace, or a member outside the brand, gets a miss', async () => {
    const account = await connection({
      externalAccountId: `acct-${randomUUID()}`,
      status: 'NEEDS_REAUTH',
      connectedAt: past(60),
    });
    const job = await failedJob(account, 'AUTH_REVOKED');
    await inA((db) =>
      db.socialConnection.update({
        where: { id: account },
        data: { status: 'ACTIVE', connectedAt: new Date() },
      }),
    );
    await expect(retry(job, [], fixtures.b.workspaceId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(retry(job, [randomUUID()])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await readJob(job)).status).toBe('FAILED');
  });
});
