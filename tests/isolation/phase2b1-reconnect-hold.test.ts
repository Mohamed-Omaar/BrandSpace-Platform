import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfigPayload } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { ContentCalendarService, parseContentPolicy } from '@brandspace/content';
import {
  AWAITING_RECONNECT_CODE,
  RECONNECT_REQUIRED_CODE,
  PublishPipelineService,
  SocialTokenVault,
  createConnectorRegistry,
  parsePublishingPolicy,
  unreachableChannelGate,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  type IsolationFixtures,
} from './fixtures';

/**
 * PROTOTYPE v94 PHASE 2B-1, ITEM 5 — Q9: AN EXPIRED CHANNEL WAITS, THE REST
 * PUBLISH ON TIME (D-332), AGAINST REAL POSTGRESQL.
 *
 * Before: `materialiseSlot` read ACTIVE connections only, so a post written
 * for LinkedIn and X whose X account needed reconnecting went out on LinkedIn
 * and silently never tried X. Now X gets its job, the job waits for the
 * account until the lateness deadline, and then fails saying to reconnect it —
 * while LinkedIn publishes on time. A channel whose every account was REVOKED
 * is refused when scheduling.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;

const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});

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

/** A brand of its own in workspace A: LinkedIn connected, X needing reconnection. */
async function world(xStatus: 'NEEDS_REAUTH' | 'REVOKED') {
  return inA(async (db) => {
    const workspaceId = fixtures.a.workspaceId;
    const suffix = randomUUID().slice(0, 8);
    const brand = await db.brand.create({
      data: { workspaceId, slug: `q9-${suffix}`, name: `Q9 ${suffix}`, status: 'ACTIVE' },
    });
    const connectionIds: Record<'LINKEDIN' | 'X', string> = { LINKEDIN: '', X: '' };
    for (const [provider, status] of [
      ['LINKEDIN', 'ACTIVE'],
      ['X', xStatus],
    ] as const) {
      const connection = await db.socialConnection.create({
        data: {
          workspaceId,
          brandId: brand.id,
          provider,
          externalAccountId: `q9-${provider}-${suffix}`,
          displayName: `Q9 ${provider}`,
          targetKind: 'organization',
          status,
          // CHECK `social_connection_revoked_consistently`: revoked ⇔ revokedAt.
          revokedAt: status === 'REVOKED' ? new Date() : null,
          grantedScopes: ['w_member_social'],
          connectedByUserId: fixtures.a.userId,
          connectedAt: new Date(),
          tokenExpiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const sealed = await vault.seal({
        workspaceId,
        socialConnectionId: connection.id,
        version: 1,
        material: { accessToken: `q9-token-${suffix}`, refreshToken: `q9-refresh-${suffix}` },
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
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          hasRefreshToken: true,
        },
      });
      connectionIds[provider] = connection.id;
    }
    const item = await db.contentItem.create({
      data: {
        workspaceId,
        brandId: brand.id,
        title: `Q9 post ${suffix}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'SCHEDULED',
        origin: 'HUMAN',
        createdByUserId: fixtures.a.userId,
        idempotencyKey: `q9-item-${suffix}`,
      },
    });
    for (const platformKey of ['linkedin', 'x']) {
      await db.contentVariant.create({
        data: {
          workspaceId,
          brandId: brand.id,
          contentItemId: item.id,
          platformKey,
          locale: 'EN',
          body: `Q9 caption for ${platformKey}`,
          hashtags: [],
          characterCount: 20,
          validationState: 'VALID',
          origin: 'HUMAN',
        },
      });
    }
    const scheduledAtUtc = new Date(Date.UTC(2026, 8, 20, 9, 0));
    const slot = await db.calendarSlot.create({
      data: {
        workspaceId,
        brandId: brand.id,
        contentItemId: item.id,
        scheduledAtUtc,
        scheduledLocalTime: '2026-09-20T09:00',
        timezone: 'UTC',
        status: 'SCHEDULED',
        platformKeys: ['linkedin', 'x'],
        createdByUserId: fixtures.a.userId,
        usageIdempotencyKey: `q9-slot-${suffix}`,
      },
    });
    return { brandId: brand.id, itemId: item.id, slotId: slot.id, scheduledAtUtc, connectionIds };
  });
}

const minutes = (base: Date, count: number) => new Date(base.getTime() + count * 60_000);

async function jobsOf(slotId: string) {
  return inA((db) =>
    db.publishJob.findMany({ where: { calendarSlotId: slotId }, orderBy: { provider: 'asc' } }),
  );
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = enabledPolicy();
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('Q9 · an expired channel waits for its account; the others publish on time', () => {
  it('creates the expired channel’s job instead of silently dropping it', async () => {
    const q9 = await world('NEEDS_REAUTH');
    const result = await inA((db) => pipeline(db, q9.scheduledAtUtc).materialiseSlot(q9.slotId));
    expect(result.created).toBe(2);
    expect((await jobsOf(q9.slotId)).map((job) => job.provider)).toEqual(['LINKEDIN', 'X']);
  });

  it('publishes LinkedIn on time, holds X without an attempt, then fails X at the deadline saying to reconnect', async () => {
    const q9 = await world('NEEDS_REAUTH');
    const onTime = minutes(q9.scheduledAtUtc, 1);
    await inA((db) => pipeline(db, onTime).materialiseSlot(q9.slotId));
    const [linkedin, x] = await jobsOf(q9.slotId);

    expect((await inA((db) => pipeline(db, onTime).execute(linkedin!.id))).status).toBe(
      'PUBLISHED',
    );

    // Held: back to QUEUED, nothing attempted, the reason on the row.
    const held = await inA((db) => pipeline(db, onTime).execute(x!.id));
    expect(held.status).toBe('QUEUED');
    const heldRow = (await jobsOf(q9.slotId))[1]!;
    expect(heldRow).toMatchObject({
      status: 'QUEUED',
      attemptCount: 0,
      failureCode: AWAITING_RECONNECT_CODE,
    });
    expect(heldRow.nextAttemptAt!.getTime()).toBe(onTime.getTime() + 60_000);
    expect(await inA((db) => db.publishAttempt.count({ where: { publishJobId: x!.id } }))).toBe(0);
    // The slot is still going out: one channel is waiting.
    expect(
      (await inA((db) => db.calendarSlot.findFirst({ where: { id: q9.slotId } })))?.status,
    ).toBe('PUBLISHING');

    // Past the lateness deadline (120 minutes by default): fails, with the reason.
    const late = minutes(q9.scheduledAtUtc, 121);
    const failed = await inA((db) => pipeline(db, late).execute(x!.id));
    expect(failed.status).toBe('FAILED');
    expect((await jobsOf(q9.slotId))[1]).toMatchObject({
      status: 'FAILED',
      failureClass: 'NOT_CONNECTED',
      failureCode: RECONNECT_REQUIRED_CODE,
    });
    expect(
      (await inA((db) => db.calendarSlot.findFirst({ where: { id: q9.slotId } })))?.status,
    ).toBe('PARTIALLY_PUBLISHED');
  });

  it('a held channel publishes once its account is reconnected in time', async () => {
    const q9 = await world('NEEDS_REAUTH');
    const onTime = minutes(q9.scheduledAtUtc, 1);
    await inA((db) => pipeline(db, onTime).materialiseSlot(q9.slotId));
    const x = (await jobsOf(q9.slotId))[1]!;
    await inA((db) => pipeline(db, onTime).execute(x.id));

    await inA((db) =>
      db.socialConnection.update({ where: { id: q9.connectionIds.X }, data: { status: 'ACTIVE' } }),
    );
    const result = await inA((db) => pipeline(db, minutes(q9.scheduledAtUtc, 30)).execute(x.id));
    expect(result.status).toBe('PUBLISHED');
    expect((await jobsOf(q9.slotId))[1]).toMatchObject({ failureCode: null, failureClass: null });
  });

  it('reconnected only after the deadline, it still fails with the reconnect reason', async () => {
    const q9 = await world('NEEDS_REAUTH');
    await inA((db) => pipeline(db, q9.scheduledAtUtc).materialiseSlot(q9.slotId));
    const x = (await jobsOf(q9.slotId))[1]!;
    await inA((db) => pipeline(db, q9.scheduledAtUtc).execute(x.id));
    await inA((db) =>
      db.socialConnection.update({ where: { id: q9.connectionIds.X }, data: { status: 'ACTIVE' } }),
    );
    await inA((db) => pipeline(db, minutes(q9.scheduledAtUtc, 125)).execute(x.id));
    expect((await jobsOf(q9.slotId))[1]).toMatchObject({
      status: 'FAILED',
      failureCode: RECONNECT_REQUIRED_CODE,
    });
  });

  it('a revoked account still gets no job — nothing is ever sent to it', async () => {
    const q9 = await world('REVOKED');
    const result = await inA((db) => pipeline(db, q9.scheduledAtUtc).materialiseSlot(q9.slotId));
    expect(result.created).toBe(1);
    expect((await jobsOf(q9.slotId)).map((job) => job.provider)).toEqual(['LINKEDIN']);
  });
});

describe('Q9 · scheduling refuses a channel whose every account was revoked', () => {
  const contentPolicy = parseContentPolicy(parseConfigPayload('content', {}));
  const localTime = `${new Date().getUTCFullYear() + 1}-07-20T09:00`;

  async function tryToSchedule(xStatus: 'NEEDS_REAUTH' | 'REVOKED') {
    const q9 = await world(xStatus);
    return inA(async (db) => {
      // A draft of its own, so the fixture slot above does not count as "already scheduled".
      await db.calendarSlot.update({
        where: { id: q9.slotId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await db.contentItem.update({ where: { id: q9.itemId }, data: { status: 'DRAFT' } });
      return new ContentCalendarService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: contentPolicy,
        timezone: 'UTC',
        quota: { limit: async () => null, consume: async () => true, refund: async () => {} },
        approvalGate: { policyForBrand: async () => ({ requireApprovalBeforeScheduling: false }) },
        channelGate: unreachableChannelGate(db, fixtures.a.workspaceId),
      }).schedule({
        contentItemId: q9.itemId,
        localTime,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      });
    });
  }

  it('refuses REVOKED, naming the reason', async () => {
    await expect(tryToSchedule('REVOKED')).rejects.toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: 'CHANNEL_DISCONNECTED', channels: 'x' },
    });
  });

  it('accepts EXPIRED — the channel will wait for its account', async () => {
    await expect(tryToSchedule('NEEDS_REAUTH')).resolves.toMatchObject({
      slot: { status: 'SCHEDULED' },
    });
  });

  it('another workspace’s revoked account is never consulted', async () => {
    // Workspace B's LinkedIn account, revoked. Asked from A about B's brand,
    // the gate must see nothing — it would answer ['linkedin'] if it could.
    const revokeB = (status: 'REVOKED' | 'ACTIVE') =>
      withWorkspace(
        fixtures.b.workspaceId,
        (db) =>
          db.socialConnection.update({
            where: { id: fixtures.b.socialConnectionId },
            data: { status, revokedAt: status === 'REVOKED' ? new Date() : null },
          }),
        { prisma: app },
      );
    await revokeB('REVOKED');
    const gateAnswer = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        unreachableChannelGate(db, fixtures.a.workspaceId).unreachableChannels(fixtures.b.brandId, [
          'x',
          'linkedin',
        ]),
      { prisma: app },
    );
    await revokeB('ACTIVE');
    expect(gateAnswer).toEqual([]);
  });
});
