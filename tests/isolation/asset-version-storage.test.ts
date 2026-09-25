import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  ASSET_CHANGED_REASON,
  AssetLibraryService,
  AssetMaintenanceService,
  AssetUploadService,
  AssetVersionService,
  assetPolicyFrom,
  type AssetActor,
  type VersionCompensationFailure,
} from '@brandspace/assets';
import { defaultPayload } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  BYTES_PER_GB,
  QUOTA_FEATURES,
  UsageService,
  recomputeStorageUsage,
} from '@brandspace/entitlements';
import {
  InMemoryObjectStore,
  checksumOf,
  type ObjectStore,
  type StoredObject,
} from '@brandspace/storage';
import { WORKSPACE_PERMISSIONS } from '@brandspace/shared';
import { appRoleClient, platformRoleClient } from './fixtures';

/**
 * B-1, completed — a new asset VERSION is storage, charged like any upload.
 *
 * `AssetVersionService.addVersion` used to write a new object without touching
 * the storage quota, while purge refunded those bytes. Against REAL PostgreSQL
 * this file proves the version path reserves exact bytes before writing, keeps
 * them only when the version commits, gives them back when it does not, can
 * never let a racing upload overwrite a winner's object, and stays under
 * tenant RLS throughout. Every test uses a FRESH workspace, so exact byte
 * counts are exact.
 */

let platform: PrismaClient;
let app: PrismaClient;
const created: string[] = [];
const MIB = 1_048_576;
const policy = assetPolicyFrom(defaultPayload('assets'));
const storageKeyOf = QUOTA_FEATURES.storageGb;

/** An ObjectStore that records what it was asked to do, and can be told to fail. */
class RecordingStore implements ObjectStore {
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  constructor(
    readonly inner: InMemoryObjectStore,
    readonly behaviour: {
      failPut?: () => boolean;
      failDelete?: boolean;
      beforePut?: (key: string) => Promise<void>;
    } = {},
  ) {}
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    this.puts.push(key);
    await this.behaviour.beforePut?.(key);
    if (this.behaviour.failPut?.()) throw new Error('object store unavailable');
    return this.inner.put(key, bytes, contentType);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  async delete(key: string) {
    this.deletes.push(key);
    if (this.behaviour.failDelete) throw new Error('object store delete failed');
    return this.inner.delete(key);
  }
}

async function freshWorkspace(): Promise<{ workspaceId: string; userId: string }> {
  const id = crypto.randomUUID();
  const user = await platform.user.create({
    data: { email: `b1v-${id}@example.local`, name: 'Version', status: 'ACTIVE', timezone: 'UTC' },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `b1v-${id.slice(0, 12)}`,
      name: 'Version Storage Workspace',
      ownerUserId: user.id,
      status: 'ACTIVE',
      country: 'SA',
      currency: 'SAR',
      defaultLocale: 'EN',
      timezone: 'UTC',
      planKey: null,
    },
  });
  created.push(id);
  return { workspaceId: id, userId: user.id };
}

/** A PNG signature followed by bytes that differ per call, exactly `size` long. */
function png(size: number, tag: string = crypto.randomUUID()): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set(new TextEncoder().encode(tag).slice(0, Math.max(0, size - 8)), 8);
  return bytes;
}

function owner(userId: string): AssetActor {
  return { userId, permissionKeys: WORKSPACE_PERMISSIONS.map((p) => p.key), brandScope: [] };
}

interface Services {
  readonly db: TenantScopedClient;
  readonly usage: UsageService;
  readonly upload: AssetUploadService;
  readonly versions: AssetVersionService;
  readonly library: AssetLibraryService;
  readonly maintenance: AssetMaintenanceService;
}

function inWs<T>(
  workspaceId: string,
  fn: (s: Services) => Promise<T>,
  options: {
    store?: ObjectStore;
    limitGb?: number | null;
    now?: () => Date;
    usage?: (real: UsageService) => UsageService;
    onCompensationFailure?: (failure: VersionCompensationFailure) => Promise<void>;
  } = {},
): Promise<T> {
  const store = options.store ?? new InMemoryObjectStore();
  const clock = options.now ? { now: options.now } : undefined;
  return withWorkspace(
    workspaceId,
    async (db) => {
      const real = new UsageService({ prisma: db as unknown as PrismaClient });
      const usage = options.usage ? options.usage(real) : real;
      const limitGb = options.limitGb ?? null;
      return fn({
        db,
        usage: real,
        upload: new AssetUploadService({
          db,
          workspaceId,
          store,
          policy,
          usage: real,
          storageLimitGb: null,
        }),
        versions: new AssetVersionService({
          db,
          workspaceId,
          store,
          policy,
          usage,
          storageLimitGb: limitGb,
          ...(clock ? { clock } : {}),
          ...(options.onCompensationFailure
            ? { onCompensationFailure: options.onCompensationFailure }
            : {}),
        }),
        library: new AssetLibraryService({ db, workspaceId, policy }),
        maintenance: new AssetMaintenanceService({
          db,
          workspaceId,
          store,
          policy,
          usage: real,
          ...(clock ? { clock } : {}),
        }),
      });
    },
    { prisma: app },
  );
}

/** Upload a first version, committed, in its own transaction. */
async function uploadAsset(
  workspaceId: string,
  userId: string,
  store: ObjectStore,
  bytes: Uint8Array,
): Promise<string> {
  return inWs(
    workspaceId,
    async (s) => {
      const session = await s.upload.initiate({
        brandId: null,
        folderId: null,
        fileName: 'photo.png',
        mimeType: 'image/png',
        sizeBytes: bytes.byteLength,
        idempotencyKey: `b1v-up-${crypto.randomUUID()}`,
        actor: owner(userId),
      });
      const done = await s.upload.complete({
        sessionId: session.session.id,
        bytes,
        actor: owner(userId),
      });
      return done.asset.id;
    },
    { store },
  );
}

async function usedBytes(workspaceId: string): Promise<bigint> {
  const row = await platform.usageCounter.findFirst({
    where: { workspaceId, featureKey: storageKeyOf },
    select: { usedBytes: true },
  });
  return row?.usedBytes ?? 0n;
}

/** Everything a version attempt could leave behind, read as the platform. */
async function footprint(assetId: string) {
  return {
    asset: await platform.asset.findUniqueOrThrow({ where: { id: assetId } }),
    versions: await platform.assetVersion.count({ where: { assetId } }),
    jobs: await platform.assetProcessingJob.count({ where: { assetId } }),
    versionAudits: await platform.auditEvent.count({
      where: { resourceId: assetId, action: 'assets.version_created' },
    }),
    versionEvents: await platform.usageEvent.findMany({
      where: { idempotencyKey: { startsWith: `asset-version:${assetId}:` } },
      select: { idempotencyKey: true, bytes: true },
      orderBy: { occurredAt: 'asc' },
    }),
  };
}

beforeAll(() => {
  platform = platformRoleClient();
  app = appRoleClient();
});

afterAll(async () => {
  if (created.length > 0) {
    await platform.workspace.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
  }
  await platform.$disconnect().catch(() => undefined);
  await app.$disconnect().catch(() => undefined);
});

describe('B-1 · a new version is charged its exact bytes', () => {
  it('(1) adding a physical version raises usedBytes by exactly its size', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const store = new InMemoryObjectStore();
    const assetId = await uploadAsset(workspaceId, userId, store, png(MIB));
    expect(await usedBytes(workspaceId)).toBe(BigInt(MIB));

    const added = await inWs(
      workspaceId,
      (s) => s.versions.addVersion({ assetId, bytes: png(3 * MIB + 17), actor: owner(userId) }),
      { store, limitGb: 1 },
    );
    expect(added.replayed).toBe(false);
    expect(await usedBytes(workspaceId)).toBe(BigInt(MIB + 3 * MIB + 17));
    // The object is really there, under the attempt's own key.
    expect(await store.get(added.version.storageKey)).not.toBeNull();
    expect(added.version.storageKey).toMatch(/\/v2-[0-9a-f-]{36}$/);
  });

  it('(2, 3) a version over the remaining quota is refused before anything is stored', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const inner = new InMemoryObjectStore();
    const assetId = await uploadAsset(workspaceId, userId, inner, png(MIB));
    // Leave exactly 1 MiB - 1 byte of a 1 GB plan.
    await inWs(workspaceId, (s) =>
      s.usage.consumeBytes({
        workspaceId,
        featureKey: storageKeyOf,
        limitGb: null,
        bytes: BYTES_PER_GB - 2 * MIB + 1,
        idempotencyKey: `b1v-fill-${workspaceId}`,
      }),
    );
    const before = await footprint(assetId);
    const counterBefore = await usedBytes(workspaceId);
    const store = new RecordingStore(inner);

    await expect(
      inWs(
        workspaceId,
        (s) => s.versions.addVersion({ assetId, bytes: png(MIB), actor: owner(userId) }),
        { store, limitGb: 1 },
      ),
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      message: 'This workspace has reached its storage limit.',
    });

    // "Stores nothing": no object, no row, no job, no audit, no movement, no change.
    expect(store.puts).toEqual([]);
    const after = await footprint(assetId);
    expect(after.versions).toBe(before.versions);
    expect(after.jobs).toBe(before.jobs);
    expect(after.versionAudits).toBe(0);
    expect(after.versionEvents).toEqual([]);
    expect(after.asset).toEqual(before.asset);
    expect(await usedBytes(workspaceId)).toBe(counterBefore);

    // Just fitting is admitted: exactly the remaining bytes.
    await inWs(
      workspaceId,
      (s) => s.versions.addVersion({ assetId, bytes: png(MIB - 1), actor: owner(userId) }),
      { store, limitGb: 1 },
    );
    expect(await usedBytes(workspaceId)).toBe(BigInt(BYTES_PER_GB));
  });
});

describe('B-1 · replay is proved by the CURRENT version, not by a usage event', () => {
  it('(4) an immediate retry of the current version stores and charges nothing', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const inner = new InMemoryObjectStore();
    const assetId = await uploadAsset(workspaceId, userId, inner, png(MIB));
    const store = new RecordingStore(inner);
    const bytes = png(2 * MIB);

    const first = await inWs(
      workspaceId,
      (s) => s.versions.addVersion({ assetId, bytes, actor: owner(userId) }),
      { store },
    );
    const charged = await usedBytes(workspaceId);
    const state = await footprint(assetId);

    const again = await inWs(
      workspaceId,
      (s) => s.versions.addVersion({ assetId, bytes, actor: owner(userId) }),
      { store },
    );
    expect(again.replayed).toBe(true);
    expect(again.version.id).toBe(first.version.id);
    expect(store.puts).toHaveLength(1);
    expect(await usedBytes(workspaceId)).toBe(charged);
    expect((await footprint(assetId)).versions).toBe(state.versions);
  });

  it('the same bytes as an OLDER version are a new upload, charged again (the documented limit)', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const store = new InMemoryObjectStore();
    const assetId = await uploadAsset(workspaceId, userId, store, png(MIB));
    const a = png(2 * MIB, 'bytes-a');
    await inWs(
      workspaceId,
      (s) => s.versions.addVersion({ assetId, bytes: a, actor: owner(userId) }),
      {
        store,
      },
    );
    await inWs(
      workspaceId,
      (s) => s.versions.addVersion({ assetId, bytes: png(MIB, 'bytes-b'), actor: owner(userId) }),
      { store },
    );
    const again = await inWs(
      workspaceId,
      (s) => s.versions.addVersion({ assetId, bytes: a, actor: owner(userId) }),
      { store },
    );
    expect(again.replayed).toBe(false);
    expect(await usedBytes(workspaceId)).toBe(BigInt(MIB + 2 * MIB + MIB + 2 * MIB));
  });
});

describe('B-1 · a failed attempt is compensated, and its retry is charged once', () => {
  it('(5, 16, 17) put fails → refunded; retry succeeds; exactly one version charged; keys never collide', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const inner = new InMemoryObjectStore();
    const assetId = await uploadAsset(workspaceId, userId, inner, png(MIB));
    const base = await usedBytes(workspaceId);
    let failNext = true;
    const store = new RecordingStore(inner, {
      failPut: () => {
        const fail = failNext;
        failNext = false;
        return fail;
      },
    });
    const bytes = png(2 * MIB);

    // Caught INSIDE the transaction, so it commits: what remains is exactly
    // what the service itself did about the failure — not a rollback.
    await inWs(
      workspaceId,
      async (s) => {
        await expect(
          s.versions.addVersion({ assetId, bytes, actor: owner(userId) }),
        ).rejects.toThrow('object store unavailable');
      },
      { store },
    );
    expect(await usedBytes(workspaceId)).toBe(base);
    const afterFailure = await footprint(assetId);
    expect(afterFailure.versionEvents.map((e) => e.bytes)).toEqual([
      BigInt(2 * MIB),
      BigInt(-2 * MIB),
    ]);
    expect(afterFailure.versions).toBe(1);
    // The attempt's own object key is deleted — and only that key.
    expect(store.deletes).toEqual([store.puts[0]]);

    // The retry reserves again from scratch: a refunded key is not a success.
    const retried = await inWs(
      workspaceId,
      (s) => s.versions.addVersion({ assetId, bytes, actor: owner(userId) }),
      { store },
    );
    expect(retried.replayed).toBe(false);
    expect(await usedBytes(workspaceId)).toBe(base + BigInt(2 * MIB));
    const final = await footprint(assetId);
    expect(final.versions).toBe(2);

    // (16) Every movement has its own key: attempt-scoped, typed, distinct
    // from ordinary uploads and purges.
    const keys = final.versionEvents.map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(key).toMatch(new RegExp(`^asset-version:${assetId}:[0-9a-f-]{36}:(consume|refund)$`));
    }

    // (17) Repeating the compensating refund cannot give the bytes back twice.
    const refundKey = keys.find((k) => k.endsWith(':refund'));
    if (!refundKey) throw new Error('the failed attempt recorded no refund');
    await inWs(workspaceId, (s) =>
      s.usage.refundBytes({
        workspaceId,
        featureKey: storageKeyOf,
        bytes: 2 * MIB,
        idempotencyKey: refundKey,
      }),
    );
    expect(await usedBytes(workspaceId)).toBe(base + BigInt(2 * MIB));
  });

  it('(6) the database step fails after the object was written → object deleted, bytes refunded, nothing committed', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const inner = new InMemoryObjectStore();
    const assetId = await uploadAsset(workspaceId, userId, inner, png(MIB));
    const base = await usedBytes(workspaceId);
    const before = await footprint(assetId);
    const store = new RecordingStore(inner);

    // The failure happens INSIDE the savepoint, after the asset claim and the
    // version INSERT have both run: the processing job reads the clock, and
    // the clock throws. Both writes must roll back with it.
    await inWs(
      workspaceId,
      async (s) => {
        await expect(
          s.versions.addVersion({ assetId, bytes: png(2 * MIB), actor: owner(userId) }),
        ).rejects.toThrow('clock stopped');
      },
      {
        store,
        now: () => {
          throw new Error('clock stopped');
        },
      },
    );

    const after = await footprint(assetId);
    expect(after.asset).toEqual(before.asset);
    expect(after.versions).toBe(before.versions);
    expect(after.jobs).toBe(before.jobs);
    expect(after.versionAudits).toBe(0);
    expect(await store.get(store.puts[0] as string)).toBeNull();
    expect(await usedBytes(workspaceId)).toBe(base);
    expect(after.versionEvents.map((e) => e.bytes)).toEqual([BigInt(2 * MIB), BigInt(-2 * MIB)]);
  });

  it('(6) a real DATABASE error in the savepoint is a retryable conflict, compensated, never a raw constraint error', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const inner = new InMemoryObjectStore();
    const assetId = await uploadAsset(workspaceId, userId, inner, png(MIB));
    // Another path took version 2 without moving the asset — the version
    // INSERT will hit the unique constraint inside the savepoint.
    await platform.assetVersion.create({
      data: {
        workspaceId,
        assetId,
        versionNumber: 2,
        storageKey: `ws/${workspaceId}/asset/${assetId}/v2-planted`,
        checksumSha256: 'planted',
        mimeType: 'image/png',
        sizeBytes: 1,
      },
    });
    const base = await usedBytes(workspaceId);
    const before = await footprint(assetId);
    const store = new RecordingStore(inner);

    let caught: unknown;
    await inWs(
      workspaceId,
      async (s) => {
        caught = await s.versions
          .addVersion({ assetId, bytes: png(2 * MIB), actor: owner(userId) })
          .catch((error: unknown) => error);
      },
      { store },
    );
    expect(caught).toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: ASSET_CHANGED_REASON, retryable: true },
    });
    expect(String((caught as Error).message)).not.toMatch(/unique|P2002|constraint/i);

    const after = await footprint(assetId);
    expect(after.asset).toEqual(before.asset);
    expect(after.versions).toBe(before.versions);
    expect(after.jobs).toBe(before.jobs);
    expect(await store.get(store.puts[0] as string)).toBeNull();
    expect(await usedBytes(workspaceId)).toBe(base);
  });
});

describe('B-1 · restore, purge and recompute count each physical object once', () => {
  it('(7, 8, 9, 14, 15) v1 → new v2 → restore v1: restore costs 0; recompute agrees; purge refunds distinct bytes', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const store = new InMemoryObjectStore();
    const assetId = await uploadAsset(workspaceId, userId, store, png(MIB + 11));
    await inWs(
      workspaceId,
      (s) => s.versions.addVersion({ assetId, bytes: png(2 * MIB + 7), actor: owner(userId) }),
      { store },
    );
    const beforeRestore = await usedBytes(workspaceId);
    expect(beforeRestore).toBe(BigInt(3 * MIB + 18));

    const restored = await inWs(
      workspaceId,
      (s) => s.versions.restoreVersion({ assetId, versionNumber: 1, actor: owner(userId) }),
      { store },
    );
    // (7) Zero new bytes: the restored row shares version 1's object.
    expect(await usedBytes(workspaceId)).toBe(beforeRestore);
    const v1 = await platform.assetVersion.findFirstOrThrow({
      where: { assetId, versionNumber: 1 },
    });
    expect(restored.version.storageKey).toBe(v1.storageKey);

    // (14) The recompute measures the same thing the live counter holds.
    expect(await recomputeStorageUsage(platform, { apply: false, workspaceId })).toEqual([]);

    // (8, 9, 15) Purge refunds exactly the distinct objects, once each.
    await inWs(workspaceId, (s) => s.library.delete(assetId, owner(userId)), { store });
    const afterGrace = () =>
      new Date(Date.now() + (policy.retention.purgeDeletedAfterDays + 1) * 86_400_000);
    await inWs(workspaceId, (s) => s.maintenance.purgeDeletedAssets(), { store, now: afterGrace });
    expect(await usedBytes(workspaceId)).toBe(0n);
    expect(await recomputeStorageUsage(platform, { apply: false, workspaceId })).toEqual([]);
  });

  it('(12, 13) historical versions nobody charged are counted by recompute, and a shared key once', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const store = new InMemoryObjectStore();
    const assetId = await uploadAsset(workspaceId, userId, store, png(MIB));
    // Pre-fix history, written the way the old code wrote it: a v2 object
    // that was never charged, and a restore row sharing v1's key.
    const v1 = await platform.assetVersion.findFirstOrThrow({
      where: { assetId, versionNumber: 1 },
    });
    await platform.assetVersion.create({
      data: {
        workspaceId,
        assetId,
        versionNumber: 2,
        storageKey: `ws/${workspaceId}/asset/${assetId}/v2`,
        checksumSha256: 'historic-v2',
        mimeType: 'image/png',
        sizeBytes: 5 * MIB,
      },
    });
    await platform.assetVersion.create({
      data: {
        workspaceId,
        assetId,
        versionNumber: 3,
        storageKey: v1.storageKey,
        checksumSha256: v1.checksumSha256,
        mimeType: 'image/png',
        sizeBytes: v1.sizeBytes,
      },
    });

    const drift = await recomputeStorageUsage(platform, { apply: false, workspaceId });
    expect(drift).toHaveLength(1);
    expect(drift[0]?.storedBytes).toBe(BigInt(MIB + 5 * MIB));
    expect(drift[0]?.recordedBytes).toBe(BigInt(MIB));
  });
});

describe('B-1 · two version uploads racing on one asset', () => {
  it('(10, 11) one wins; the loser cannot touch its object, leaves nothing, refunds itself, and gets a retryable conflict', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const inner = new InMemoryObjectStore();
    const assetId = await uploadAsset(workspaceId, userId, inner, png(MIB));
    const base = await usedBytes(workspaceId);
    const before = await footprint(assetId);

    /*
     * DETERMINISTIC OVERLAP. Whichever request reserves first holds the
     * storage counter's row lock until it commits; it waits in `put` until
     * the OTHER request is visibly blocked on that lock — which it can only
     * be after it has read the asset at version 1. So the second request is
     * always working from a version that is no longer current.
     */
    const waitForBlockedPeer = async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const [row] = await platform.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting FROM pg_locks WHERE NOT granted`;
        if ((row?.waiting ?? 0n) > 0n) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const stores = [0, 1].map(() => new RecordingStore(inner, { beforePut: waitForBlockedPeer }));
    const payloads = [png(2 * MIB, 'racer-a'), png(3 * MIB, 'racer-b')];

    const results = await Promise.allSettled(
      [0, 1].map((i) =>
        inWs(
          workspaceId,
          (s) =>
            s.versions.addVersion({
              assetId,
              bytes: payloads[i] as Uint8Array,
              actor: owner(userId),
            }),
          { store: stores[i] as RecordingStore },
        ),
      ),
    );

    const won = results.findIndex((r) => r.status === 'fulfilled');
    const lost = results.findIndex((r) => r.status === 'rejected');
    expect(won).toBeGreaterThanOrEqual(0);
    expect(lost).toBeGreaterThanOrEqual(0);

    // (11) The loser is told, in domain terms, to retry.
    const reason = (results[lost] as PromiseRejectedResult).reason as Error;
    expect(reason).toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: ASSET_CHANGED_REASON, retryable: true },
    });
    expect(reason.message).toBe(
      'This asset changed while your version was being uploaded. Please try again.',
    );
    expect(reason.message).not.toMatch(/unique|P2002|constraint/i);

    // (10) The winner's object is intact and matches what it recorded.
    const winner = await platform.assetVersion.findFirstOrThrow({
      where: { assetId, versionNumber: 2 },
    });
    const winnerBytes = await inner.get(winner.storageKey);
    expect(winnerBytes).not.toBeNull();
    expect(await checksumOf(winnerBytes as Uint8Array)).toBe(winner.checksumSha256);
    const loserKey = (stores[lost] as RecordingStore).puts[0] as string;
    expect(loserKey).not.toBe(winner.storageKey);
    expect(await inner.get(loserKey)).toBeNull();

    // Nothing of the loser was committed, and only the winner is charged.
    const after = await footprint(assetId);
    expect(after.versions).toBe(before.versions + 1);
    expect(after.jobs).toBe(before.jobs + 1);
    expect(after.versionAudits).toBe(1);
    expect(await usedBytes(workspaceId)).toBe(
      base + BigInt((payloads[won] as Uint8Array).byteLength),
    );
    expect(await recomputeStorageUsage(platform, { apply: false, workspaceId })).toEqual([]);
  });
});

describe('B-1 · the version transaction stays inside tenant RLS', () => {
  it("(18) the savepoint runs with the caller's workspace context", async () => {
    const { workspaceId } = await freshWorkspace();
    const seen = await withWorkspace(
      workspaceId,
      async (db) =>
        (db as unknown as PrismaClient).$transaction(async (tx) => {
          const [row] = await tx.$queryRaw<{ ws: string | null }[]>`
            SELECT current_setting('app.workspace_id', true) AS ws`;
          return row?.ws ?? null;
        }),
      { prisma: app },
    );
    expect(seen).toBe(workspaceId);
  });

  it('(18) another workspace cannot add or restore a version of this asset, and nothing moves', async () => {
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const store = new InMemoryObjectStore();
    const assetId = await uploadAsset(a.workspaceId, a.userId, store, png(MIB));
    const before = await footprint(assetId);
    const usedA = await usedBytes(a.workspaceId);

    for (const attempt of [
      (s: Services) => s.versions.addVersion({ assetId, bytes: png(MIB), actor: owner(b.userId) }),
      (s: Services) =>
        s.versions.restoreVersion({ assetId, versionNumber: 1, actor: owner(b.userId) }),
    ]) {
      await expect(inWs(b.workspaceId, attempt, { store })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    expect(await footprint(assetId)).toEqual(before);
    expect(await usedBytes(a.workspaceId)).toBe(usedA);
    expect(await usedBytes(b.workspaceId)).toBe(0n);
  });
});

describe('B-1 · a compensation that fails is never silent', () => {
  it('(19) the original error surfaces, and the failure is logged and handed to the recorder', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const inner = new InMemoryObjectStore();
    const assetId = await uploadAsset(workspaceId, userId, inner, png(MIB));
    const store = new RecordingStore(inner, { failPut: () => true, failDelete: true });
    const recorded: VersionCompensationFailure[] = [];
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });

    try {
      await expect(
        inWs(
          workspaceId,
          (s) => s.versions.addVersion({ assetId, bytes: png(2 * MIB), actor: owner(userId) }),
          {
            store,
            // The refund fails too.
            usage: (real) =>
              Object.assign(Object.create(real) as UsageService, {
                refundBytes: () => Promise.reject(new Error('ledger unavailable')),
                consumeBytes: real.consumeBytes.bind(real),
              }),
            onCompensationFailure: async (failure) => {
              recorded.push(failure);
            },
          },
        ),
      ).rejects.toThrow('object store unavailable');
    } finally {
      write.mockRestore();
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      workspaceId,
      assetId,
      versionNumber: 2,
      bytes: 2 * MIB,
      failed: ['object_delete', 'storage_refund'],
    });
    expect(recorded[0]?.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    const logged = lines.find((line) => line.includes('compensation did not complete'));
    expect(logged).toBeDefined();
    expect(logged).toContain(recorded[0]?.attemptId as string);
    // No version was fabricated.
    expect((await footprint(assetId)).versions).toBe(1);
  });
});
