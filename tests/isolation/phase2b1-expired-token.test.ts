import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { closeQueues } from '@brandspace/jobs';
import {
  AWAITING_RECONNECT_CODE,
  RECONNECT_REQUIRED_CODE,
  PublishPipelineService,
  SocialTokenVault,
  createConnectorRegistry,
  parsePublishingPolicy,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 2B-1 REVIEW, ITEM 3 — AN ACTIVE CONNECTION WITH AN EXPIRED TOKEN,
 * AGAINST REAL POSTGRESQL.
 *
 * The publishing sweep refreshes it through the existing refresh path before
 * the post is dispatched; the worker never sends an expired token. With no
 * refresh token or a refused refresh the connection needs reconnecting, and
 * the post waits until its deadline and then fails saying so — exactly as for
 * an account that needed reconnecting from the start (D-332).
 *
 * THE DATES ARE IN 2001 so the real sweep, driven by an injected clock, sees
 * only this suite's slots and jobs.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;
// The environment's own key: the sweep's refresh opens the credential with it.
const vault = new SocialTokenVault();
const SCHEDULED = new Date(Date.UTC(2001, 0, 10, 9, 0));
const minutes = (count: number) => new Date(SCHEDULED.getTime() + count * 60_000);
const applications = {
  resolve: async () => ({
    appId: 'fixture-app',
    clientSecret: 'fixture-secret',
    redirectUri: 'https://example.test/callback',
  }),
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
      facebook: capability,
      instagram: capability,
      tiktok: capability,
      linkedin: capability,
      x: capability,
    },
  });
}

function inA<T>(fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app }) as Promise<T>;
}

function pipeline(db: TenantScopedClient, at: Date): PublishPipelineService {
  return new PublishPipelineService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy,
    registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
    vault,
    approvals: {
      policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }),
      latestForItem: async () => ({ status: 'APPROVED' }),
    },
    clock: { now: () => at },
  });
}

/**
 * One LinkedIn post whose ACTIVE connection's token expires at `expiresAt`.
 * `refreshToken`: null for "nothing to refresh with"; containing `revoked`
 * makes the mock provider refuse the refresh.
 */
async function world(expiresAt: Date, refreshToken: string | null) {
  return inA(async (db) => {
    const workspaceId = fixtures.a.workspaceId;
    const suffix = randomUUID().slice(0, 8);
    const brand = await db.brand.create({
      data: { workspaceId, slug: `exp-${suffix}`, name: `Expired ${suffix}`, status: 'ACTIVE' },
    });
    const connection = await db.socialConnection.create({
      data: {
        workspaceId,
        brandId: brand.id,
        provider: 'LINKEDIN',
        externalAccountId: `exp-${suffix}`,
        displayName: `Expired ${suffix}`,
        targetKind: 'organization',
        status: 'ACTIVE',
        grantedScopes: ['w_member_social'],
        connectedByUserId: fixtures.a.userId,
        connectedAt: new Date(),
        tokenExpiresAt: expiresAt,
      },
    });
    const sealed = await vault.seal({
      workspaceId,
      socialConnectionId: connection.id,
      version: 1,
      material: { accessToken: `exp-token-${suffix}`, refreshToken },
    });
    await db.socialCredential.create({
      data: {
        workspaceId,
        socialConnectionId: connection.id,
        version: 1,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        authTag: sealed.authTag,
        wrappedDataKey: sealed.wrappedDataKey,
        keyProvider: sealed.keyProvider,
        keyId: sealed.keyId,
        algorithm: sealed.algorithm,
        encryptionContext: sealed.encryptionContext,
        maskedHint: sealed.maskedHint,
        fingerprint: sealed.fingerprint,
        accessTokenExpiresAt: expiresAt,
        hasRefreshToken: refreshToken !== null,
      },
    });
    const item = await db.contentItem.create({
      data: {
        workspaceId,
        brandId: brand.id,
        title: `Expired post ${suffix}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'SCHEDULED',
        origin: 'HUMAN',
        createdByUserId: fixtures.a.userId,
        idempotencyKey: `exp-item-${suffix}`,
      },
    });
    await db.contentVariant.create({
      data: {
        workspaceId,
        brandId: brand.id,
        contentItemId: item.id,
        platformKey: 'linkedin',
        locale: 'EN',
        body: 'Caption',
        hashtags: [],
        characterCount: 7,
        validationState: 'VALID',
        origin: 'HUMAN',
      },
    });
    const slot = await db.calendarSlot.create({
      data: {
        workspaceId,
        brandId: brand.id,
        contentItemId: item.id,
        scheduledAtUtc: SCHEDULED,
        scheduledLocalTime: '2001-01-10T09:00',
        timezone: 'UTC',
        status: 'SCHEDULED',
        platformKeys: ['linkedin'],
        createdByUserId: fixtures.a.userId,
        usageIdempotencyKey: `exp-slot-${suffix}`,
      },
    });
    await pipeline(db, SCHEDULED).materialiseSlot(slot.id);
    const job = await db.publishJob.findFirstOrThrow({ where: { calendarSlotId: slot.id } });
    return { connectionId: connection.id, jobId: job.id };
  });
}

const job = (id: string) => inA((db) => db.publishJob.findUniqueOrThrow({ where: { id } }));
const attempts = (id: string) =>
  inA((db) => db.publishAttempt.count({ where: { publishJobId: id } }));
const connection = (id: string) =>
  inA((db) => db.socialConnection.findUniqueOrThrow({ where: { id } }));
const sweep = (at: Date) =>
  new MaintenanceScheduler({
    environment: 'DEVELOPMENT',
    clock: { now: () => at },
    socialApplications: applications,
  }).sweepPublishing(500);

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = enabledPolicy();
}, 60_000);

afterAll(async () => {
  await closeQueues();
  await app?.$disconnect();
});

describe('Review item 3 · the worker never sends an expired token', () => {
  it('ACTIVE with an unexpired token publishes normally', async () => {
    const w = await world(minutes(600), 'exp-refresh');
    const result = await inA((db) => pipeline(db, minutes(1)).execute(w.jobId));
    expect(result.status).toBe('PUBLISHED');
  });

  it('ACTIVE with an expired token is held like NEEDS_REAUTH: no provider call, then reconnect-required at the deadline', async () => {
    const w = await world(minutes(-5), 'exp-refresh');
    const held = await inA((db) => pipeline(db, minutes(1)).execute(w.jobId));
    expect(held.status).toBe('QUEUED');
    expect(await job(w.jobId)).toMatchObject({
      status: 'QUEUED',
      attemptCount: 0,
      failureCode: AWAITING_RECONNECT_CODE,
    });
    // NOTHING WAS SENT: every provider call records an attempt.
    expect(await attempts(w.jobId)).toBe(0);
    // The persisted status is left to the refresh path.
    expect((await connection(w.connectionId)).status).toBe('ACTIVE');

    const failed = await inA((db) => pipeline(db, minutes(125)).execute(w.jobId));
    expect(failed.status).toBe('FAILED');
    expect(await job(w.jobId)).toMatchObject({
      failureClass: 'NOT_CONNECTED',
      failureCode: RECONNECT_REQUIRED_CODE,
    });
    expect(await attempts(w.jobId)).toBe(0);
  });

  it('held, then reconnected (a fresh token) before the deadline: publishes', async () => {
    const w = await world(minutes(-5), 'exp-refresh');
    await inA((db) => pipeline(db, minutes(1)).execute(w.jobId));
    await inA((db) =>
      db.socialConnection.update({
        where: { id: w.connectionId },
        data: { tokenExpiresAt: minutes(600) },
      }),
    );
    const result = await inA((db) => pipeline(db, minutes(30)).execute(w.jobId));
    expect(result.status).toBe('PUBLISHED');
  });
});

describe('Review item 3 · the publishing sweep refreshes first, through the existing refresh path', () => {
  it('expired + refreshable: the sweep refreshes it, and the post publishes with the new credential', async () => {
    const w = await world(minutes(-5), 'exp-refresh');
    await sweep(minutes(1));
    const refreshed = await connection(w.connectionId);
    expect(refreshed.status).toBe('ACTIVE');
    expect(refreshed.tokenExpiresAt!.getTime()).toBeGreaterThan(minutes(1).getTime());
    const live = await inA((db) =>
      db.socialCredential.findFirstOrThrow({
        where: { socialConnectionId: w.connectionId, retiredAt: null },
      }),
    );
    expect(live.version).toBe(2);

    const result = await inA((db) => pipeline(db, minutes(2)).execute(w.jobId));
    expect(result.status).toBe('PUBLISHED');
  });

  it('expired with no refresh token: the connection needs reconnecting and the post is held', async () => {
    const w = await world(minutes(-5), null);
    await sweep(minutes(1));
    expect((await connection(w.connectionId)).status).toBe('NEEDS_REAUTH');
    const held = await inA((db) => pipeline(db, minutes(2)).execute(w.jobId));
    expect(held.status).toBe('QUEUED');
    expect(await attempts(w.jobId)).toBe(0);
  });

  it('expired and the refresh is refused: the connection needs reconnecting and the post is held, then fails at the deadline', async () => {
    const w = await world(minutes(-5), 'exp-refresh-revoked');
    await sweep(minutes(1));
    expect((await connection(w.connectionId)).status).toBe('NEEDS_REAUTH');
    expect((await inA((db) => pipeline(db, minutes(2)).execute(w.jobId))).status).toBe('QUEUED');
    await inA((db) => pipeline(db, minutes(125)).execute(w.jobId));
    expect(await job(w.jobId)).toMatchObject({
      status: 'FAILED',
      failureCode: RECONNECT_REQUIRED_CODE,
    });
    expect(await attempts(w.jobId)).toBe(0);
  });
});
