import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  PublishPipelineService,
  SocialTokenVault,
  createConnectorRegistry,
  parsePublishingPolicy,
  type PublishingPolicy,
} from '@brandspace/social-connectors';
import {
  appRoleClient,
  createIsolationFixtures,
  FIXTURE_SOCIAL_KEK,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2B-1 REVIEW, ITEM 4 — A TIME-ZONE CHANGE RACING THE PUBLISHING SWEEP,
 * AGAINST REAL POSTGRESQL.
 *
 * `materialiseSlot` decides from the slot it READ. The slot is claimed — still
 * SCHEDULED, still at the instant read — under a row lock, in the same
 * transaction as the job insert and the move to PUBLISHING. A change that
 * committed in between makes the claim miss and nothing is created; a change
 * that arrives after the claim waits for it and then leaves the slot alone; a
 * failure after the claim rolls everything back.
 *
 * THE INTERLEAVING IS REAL: the "time-zone change" is committed on a second
 * connection at a chosen point inside the materialisation's transaction.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: PublishingPolicy;
const vault = new SocialTokenVault({
  env: { SOCIAL_TOKEN_VAULT_KEK: FIXTURE_SOCIAL_KEK } as NodeJS.ProcessEnv,
});
const SCHEDULED = new Date(Date.UTC(2002, 2, 5, 9, 0));

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

function pipeline(db: TenantScopedClient): PublishPipelineService {
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
    clock: { now: () => SCHEDULED },
  });
}

/** A method of the client, called through the proxy with its own arguments. */
type AnyFn = (...args: unknown[]) => unknown;

/**
 * The tenant client, with `hook` run once right after the first call to
 * `model.method` resolves — or, with `fail`, that call replaced by an error.
 */
function intercept(
  db: TenantScopedClient,
  model: 'contentItem' | 'publishJob',
  method: 'findFirst' | 'createMany' | 'update',
  behaviour: { hook?: () => Promise<void>; fail?: boolean },
): TenantScopedClient {
  let done = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== model) {
        return typeof value === 'function' ? (value as AnyFn).bind(target) : value;
      }
      return new Proxy(value as object, {
        get(delegate, name) {
          const fn = Reflect.get(delegate, name) as unknown;
          if (name !== method || done || typeof fn !== 'function') {
            return typeof fn === 'function' ? (fn as AnyFn).bind(delegate) : fn;
          }
          return async (...args: unknown[]) => {
            done = true;
            if (behaviour.fail) throw new Error('injected failure after the claim');
            const result = await (fn as AnyFn).apply(delegate, args);
            await behaviour.hook?.();
            return result;
          };
        },
      });
    },
  }) as TenantScopedClient;
}

async function world() {
  return inA(async (db) => {
    const workspaceId = fixtures.a.workspaceId;
    const suffix = randomUUID().slice(0, 8);
    const brand = await db.brand.create({
      data: { workspaceId, slug: `claim-${suffix}`, name: `Claim ${suffix}`, status: 'ACTIVE' },
    });
    await db.socialConnection.create({
      data: {
        workspaceId,
        brandId: brand.id,
        provider: 'LINKEDIN',
        externalAccountId: `claim-${suffix}`,
        displayName: `Claim ${suffix}`,
        targetKind: 'organization',
        status: 'ACTIVE',
        grantedScopes: ['w_member_social'],
        connectedByUserId: fixtures.a.userId,
        connectedAt: new Date(),
      },
    });
    const item = await db.contentItem.create({
      data: {
        workspaceId,
        brandId: brand.id,
        title: `Claim ${suffix}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'SCHEDULED',
        origin: 'HUMAN',
        createdByUserId: fixtures.a.userId,
        idempotencyKey: `claim-item-${suffix}`,
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
        scheduledLocalTime: '2002-03-05T09:00',
        timezone: 'UTC',
        status: 'SCHEDULED',
        platformKeys: ['linkedin'],
        createdByUserId: fixtures.a.userId,
        usageIdempotencyKey: `claim-slot-${suffix}`,
      },
    });
    return { slotId: slot.id, itemId: item.id };
  });
}

const slotOf = (id: string) => platform.calendarSlot.findUniqueOrThrow({ where: { id } });
const jobsOf = (slotId: string) => platform.publishJob.count({ where: { calendarSlotId: slotId } });

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = enabledPolicy();
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('Review item 4 · a slot that changed after it was read is not materialised', () => {
  it('a time-zone change sends it back to PLANNED before the claim → no jobs, the slot left alone', async () => {
    const w = await world();
    const result = await inA((db) =>
      pipeline(
        intercept(db, 'contentItem', 'findFirst', {
          // Committed on another connection, after the read, before the claim.
          hook: async () => {
            await platform.calendarSlot.update({
              where: { id: w.slotId },
              data: { status: 'PLANNED', timezone: 'Asia/Tokyo' },
            });
          },
        }),
      ).materialiseSlot(w.slotId),
    );
    expect(result).toMatchObject({ created: 0, skipReason: 'slot_changed' });
    expect(await jobsOf(w.slotId)).toBe(0);
    expect(await slotOf(w.slotId)).toMatchObject({ status: 'PLANNED', timezone: 'Asia/Tokyo' });
  });

  it('its instant moved after the read (still SCHEDULED) → the stale materialisation creates nothing', async () => {
    const w = await world();
    const moved = new Date(SCHEDULED.getTime() + 3 * 3_600_000);
    const result = await inA((db) =>
      pipeline(
        intercept(db, 'contentItem', 'findFirst', {
          hook: async () => {
            await platform.calendarSlot.update({
              where: { id: w.slotId },
              data: { scheduledAtUtc: moved },
            });
          },
        }),
      ).materialiseSlot(w.slotId),
    );
    expect(result).toMatchObject({ created: 0, skipReason: 'slot_changed' });
    expect(await jobsOf(w.slotId)).toBe(0);
    expect(await slotOf(w.slotId)).toMatchObject({ status: 'SCHEDULED', scheduledAtUtc: moved });
  });

  it('a change arriving AFTER the claim waits for it, then finds the slot PUBLISHING and moves nothing', async () => {
    const w = await world();
    let concurrent: Promise<{ count: number }> | null = null;
    const result = await inA((db) =>
      pipeline(
        intercept(db, 'publishJob', 'createMany', {
          // The time-zone service's own conditional update, started while the
          // claim holds the row lock. It cannot finish until this commits.
          hook: async () => {
            concurrent = platform.calendarSlot.updateMany({
              where: { id: w.slotId, status: { in: ['PLANNED', 'SCHEDULED'] } },
              data: { scheduledAtUtc: new Date(SCHEDULED.getTime() + 3_600_000) },
            });
            await new Promise((resolve) => setTimeout(resolve, 200));
          },
        }),
      ).materialiseSlot(w.slotId),
    );
    expect(result.created).toBe(1);
    expect(await concurrent).toEqual({ count: 0 });
    expect(await slotOf(w.slotId)).toMatchObject({
      status: 'PUBLISHING',
      scheduledAtUtc: SCHEDULED,
    });
    expect(await jobsOf(w.slotId)).toBe(1);
  });
});

describe('Review item 4 · the claim, the jobs and the transition are one transaction', () => {
  it('a failure after the claim rolls back the jobs and the transition: the slot is unchanged', async () => {
    const w = await world();
    await expect(
      inA((db) =>
        pipeline(intercept(db, 'contentItem', 'update', { fail: true })).materialiseSlot(w.slotId),
      ),
    ).rejects.toThrow(/injected failure/);
    expect(await jobsOf(w.slotId)).toBe(0);
    expect(await slotOf(w.slotId)).toMatchObject({
      status: 'SCHEDULED',
      scheduledAtUtc: SCHEDULED,
    });
    expect((await platform.contentItem.findUniqueOrThrow({ where: { id: w.itemId } })).status).toBe(
      'SCHEDULED',
    );
  });

  it('an unchanged slot still materialises: its job, then PUBLISHING; a second pass creates nothing', async () => {
    const w = await world();
    const first = await inA((db) => pipeline(db).materialiseSlot(w.slotId));
    expect(first).toMatchObject({ created: 1, existing: 0 });
    expect((await slotOf(w.slotId)).status).toBe('PUBLISHING');
    expect((await platform.contentItem.findUniqueOrThrow({ where: { id: w.itemId } })).status).toBe(
      'PUBLISHING',
    );
    const again = await inA((db) => pipeline(db).materialiseSlot(w.slotId));
    expect(again).toMatchObject({ created: 0, skipReason: 'slot_not_scheduled' });
    expect(await jobsOf(w.slotId)).toBe(1);
  });
});
