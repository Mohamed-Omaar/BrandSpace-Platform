import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  AssetLibraryService,
  AssetMaintenanceService,
  AssetUploadService,
  assetPolicyFrom,
  type AssetActor,
} from '@brandspace/assets';
import { defaultPayload } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  BYTES_PER_GB,
  QUOTA_FEATURES,
  UsageService,
  recomputeStorageUsage,
} from '@brandspace/entitlements';
import { InMemoryObjectStore } from '@brandspace/storage';
import { WORKSPACE_PERMISSIONS } from '@brandspace/shared';
import { appRoleClient, platformRoleClient } from './fixtures';

/**
 * B-1 — storage is metered in BYTES, against REAL PostgreSQL.
 *
 * Every upload used to be charged as a whole gigabyte, rounded up per file, so
 * five 1 MB photos filled a 5 GB plan. The byte total, the single rounding, the
 * ceiling inside one conditional statement and the idempotency records are all
 * properties of the SQL, so they are asserted here rather than against a mock.
 *
 * Every test runs in a FRESH workspace, so no counter from another suite can
 * make an exact byte assertion approximate.
 */

let platform: PrismaClient;
let app: PrismaClient;
const created: string[] = [];
const MIB = 1_048_576;
const policy = assetPolicyFrom(defaultPayload('assets'));
const storageKey = QUOTA_FEATURES.storageGb;

async function freshWorkspace(): Promise<{ workspaceId: string; userId: string }> {
  const id = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `b1-${id}@example.local`,
      name: 'Storage Fixture',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `b1-${id.slice(0, 12)}`,
      name: 'Storage Fixture Workspace',
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

/** A PNG signature followed by bytes that differ per call, `size` long exactly. */
function photo(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set(new TextEncoder().encode(crypto.randomUUID()), 8);
  return bytes;
}

function owner(userId: string): AssetActor {
  return { userId, permissionKeys: WORKSPACE_PERMISSIONS.map((p) => p.key), brandScope: [] };
}

interface Services {
  readonly db: TenantScopedClient;
  readonly usage: UsageService;
  readonly upload: AssetUploadService;
  readonly library: AssetLibraryService;
  readonly maintenance: AssetMaintenanceService;
}

/** One transaction in `workspaceId`, under RLS, with the services built the way the app builds them. */
function inWorkspace<T>(
  workspaceId: string,
  fn: (s: Services) => Promise<T>,
  options: { limitGb?: number | null; now?: Date } = {},
): Promise<T> {
  const clock = options.now ? { now: () => options.now as Date } : undefined;
  const store = new InMemoryObjectStore();
  return withWorkspace(
    workspaceId,
    async (db) => {
      const usage = new UsageService({ prisma: db as unknown as PrismaClient });
      return fn({
        db,
        usage,
        upload: new AssetUploadService({
          db,
          workspaceId,
          store,
          policy,
          usage,
          storageLimitGb: options.limitGb ?? null,
        }),
        library: new AssetLibraryService({ db, workspaceId, policy }),
        maintenance: new AssetMaintenanceService({
          db,
          workspaceId,
          store,
          policy,
          usage,
          ...(clock ? { clock } : {}),
        }),
      });
    },
    { prisma: app },
  );
}

/** Declare an upload — the admission point, where the quota is spent. */
function initiate(s: Services, userId: string, sizeBytes: number, idempotencyKey?: string) {
  return s.upload.initiate({
    brandId: null,
    folderId: null,
    fileName: 'photo.png',
    mimeType: 'image/png',
    sizeBytes,
    idempotencyKey: idempotencyKey ?? `b1-${crypto.randomUUID()}`,
    actor: owner(userId),
  });
}

/** Upload a whole file, initiate then complete. Returns the asset id. */
async function uploadFile(
  workspaceId: string,
  userId: string,
  bytes: Uint8Array,
  limitGb: number | null,
): Promise<string> {
  return inWorkspace(
    workspaceId,
    async (s) => {
      const session = await initiate(s, userId, bytes.byteLength);
      const done = await s.upload.complete({
        sessionId: session.session.id,
        bytes,
        actor: owner(userId),
      });
      return done.asset.id;
    },
    { limitGb },
  );
}

async function counter(workspaceId: string) {
  return platform.usageCounter.findFirst({
    where: { workspaceId, featureKey: storageKey },
    select: { usedBytes: true, usedValue: true },
  });
}

/** Take the workspace to `bytes` used without creating files — the fill for boundary tests. */
function fill(workspaceId: string, bytes: number): Promise<unknown> {
  return inWorkspace(workspaceId, (s) =>
    s.usage.consumeBytes({
      workspaceId,
      featureKey: storageKey,
      limitGb: null,
      bytes,
      idempotencyKey: `b1-fill-${crypto.randomUUID()}`,
    }),
  );
}

beforeAll(() => {
  platform = platformRoleClient();
  app = appRoleClient();
});

afterAll(async () => {
  if (created.length > 0) {
    await platform.workspace.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
    await platform.user
      .deleteMany({ where: { email: { startsWith: 'b1-' } } })
      .catch(() => undefined);
  }
  await platform.$disconnect().catch(() => undefined);
  await app.$disconnect().catch(() => undefined);
});

describe('B-1: storage is charged in exact bytes', () => {
  it('five 1 MB files consume exactly 5 × 1,048,576 bytes, not five gigabytes', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    for (let i = 0; i < 5; i += 1) await uploadFile(workspaceId, userId, photo(MIB), 1);

    const row = await counter(workspaceId);
    expect(row?.usedBytes).toBe(5n * 1_048_576n);
    // Display only: the gigabytes the TOTAL occupies, rounded up once.
    expect(row?.usedValue).toBe(1);
  });

  it('deleting a file refunds exactly its bytes when it is purged, once', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    await uploadFile(workspaceId, userId, photo(2 * MIB), null);
    const doomed = await uploadFile(workspaceId, userId, photo(3 * MIB + 7), null);
    expect((await counter(workspaceId))?.usedBytes).toBe(BigInt(5 * MIB + 7));

    await inWorkspace(workspaceId, (s) => s.library.delete(doomed, owner(userId)));
    // Deleted but inside its grace period, the bytes are still stored.
    expect((await counter(workspaceId))?.usedBytes).toBe(BigInt(5 * MIB + 7));

    const afterGrace = new Date(
      Date.now() + (policy.retention.purgeDeletedAfterDays + 1) * 86_400_000,
    );
    const first = await inWorkspace(workspaceId, (s) => s.maintenance.purgeDeletedAssets(), {
      now: afterGrace,
    });
    expect(first.purged).toBe(1);
    expect((await counter(workspaceId))?.usedBytes).toBe(BigInt(2 * MIB));

    // A second sweep finds nothing to purge and gives nothing back.
    await inWorkspace(workspaceId, (s) => s.maintenance.purgeDeletedAssets(), { now: afterGrace });
    expect((await counter(workspaceId))?.usedBytes).toBe(BigInt(2 * MIB));
  });

  it('accepts a file just below the remaining bytes and refuses one just above', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const ceiling = BYTES_PER_GB; // a 1 GB plan
    await fill(workspaceId, ceiling - 100);

    // 100 bytes remain: 99 fits.
    await inWorkspace(workspaceId, (s) => initiate(s, userId, 99), { limitGb: 1 });
    expect((await counter(workspaceId))?.usedBytes).toBe(BigInt(ceiling - 1));

    // 1 byte remains: 2 does not, and the refusal moves nothing.
    await expect(
      inWorkspace(workspaceId, (s) => initiate(s, userId, 2), { limitGb: 1 }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect((await counter(workspaceId))?.usedBytes).toBe(BigInt(ceiling - 1));

    // Exactly the remainder is allowed; the plan is then full to the byte.
    await inWorkspace(workspaceId, (s) => initiate(s, userId, 1), { limitGb: 1 });
    expect(await counter(workspaceId)).toEqual({ usedBytes: BigInt(ceiling), usedValue: 1 });
  });

  it('a first upload larger than the plan is refused and leaves no counter behind', async () => {
    const { workspaceId } = await freshWorkspace();
    await expect(
      inWorkspace(workspaceId, (s) =>
        s.usage.consumeBytes({
          workspaceId,
          featureKey: storageKey,
          limitGb: 1,
          bytes: BYTES_PER_GB + 1,
          idempotencyKey: `b1-first-${workspaceId}`,
        }),
      ),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(await counter(workspaceId)).toBeNull();
  });
});

describe('B-1: retries never double-charge or double-refund', () => {
  it('a retried upload initiate charges its bytes once', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const key = `b1-retry-${crypto.randomUUID()}`;
    const first = await inWorkspace(workspaceId, (s) => initiate(s, userId, 4 * MIB, key), {
      limitGb: 1,
    });
    const again = await inWorkspace(workspaceId, (s) => initiate(s, userId, 4 * MIB, key), {
      limitGb: 1,
    });
    expect(again.replayed).toBe(true);
    expect(again.session.id).toBe(first.session.id);
    expect((await counter(workspaceId))?.usedBytes).toBe(BigInt(4 * MIB));
  });

  it('a replayed movement moves nothing and a different one under the same key conflicts', async () => {
    const { workspaceId } = await freshWorkspace();
    const move = (kind: 'consume' | 'refund', bytes: number, key: string) =>
      inWorkspace<unknown>(workspaceId, (s) =>
        kind === 'consume'
          ? s.usage.consumeBytes({
              workspaceId,
              featureKey: storageKey,
              limitGb: null,
              bytes,
              idempotencyKey: key,
            })
          : s.usage.refundBytes({
              workspaceId,
              featureKey: storageKey,
              bytes,
              idempotencyKey: key,
            }),
      );

    await move('consume', 3 * MIB, `b1-c-${workspaceId}`);
    await move('consume', 3 * MIB, `b1-c-${workspaceId}`);
    expect((await counter(workspaceId))?.usedBytes).toBe(BigInt(3 * MIB));
    await expect(move('consume', 4 * MIB, `b1-c-${workspaceId}`)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    await move('refund', MIB, `b1-r-${workspaceId}`);
    await move('refund', MIB, `b1-r-${workspaceId}`);
    expect(await counter(workspaceId)).toEqual({ usedBytes: BigInt(2 * MIB), usedValue: 1 });
    // A refund reusing the CONSUMPTION's key is a different movement, not a replay.
    await expect(move('refund', 3 * MIB, `b1-c-${workspaceId}`)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // Floors at zero, and zero bytes is zero gigabytes.
    await move('refund', 10 * MIB, `b1-r2-${workspaceId}`);
    expect(await counter(workspaceId)).toEqual({ usedBytes: 0n, usedValue: 0 });
  });

  it('the same movement retried CONCURRENTLY is recorded once', async () => {
    const { workspaceId } = await freshWorkspace();
    await fill(workspaceId, MIB);
    const key = `b1-concurrent-${workspaceId}`;
    const results = await Promise.allSettled(
      [0, 1, 2].map(() =>
        inWorkspace(workspaceId, (s) =>
          s.usage.consumeBytes({
            workspaceId,
            featureKey: storageKey,
            limitGb: 1,
            bytes: 2 * MIB,
            idempotencyKey: key,
          }),
        ),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await counter(workspaceId))?.usedBytes).toBe(BigInt(3 * MIB));
  });
});

describe('B-1: the last bytes cannot be raced', () => {
  it('two uploads racing for the last remaining bytes: exactly one is admitted', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    const remaining = 5 * MIB;
    await fill(workspaceId, BYTES_PER_GB - remaining);

    const results = await Promise.allSettled([
      inWorkspace(workspaceId, (s) => initiate(s, userId, remaining), { limitGb: 1 }),
      inWorkspace(workspaceId, (s) => initiate(s, userId, remaining), { limitGb: 1 }),
    ]);

    const admitted = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect((await counter(workspaceId))?.usedBytes).toBe(BigInt(BYTES_PER_GB));
    // Exactly one session holds the bytes.
    expect(
      await platform.assetUploadSession.count({ where: { workspaceId, status: 'PENDING' } }),
    ).toBe(1);
  });
});

describe('B-1: recomputing a counter from what is stored', () => {
  it('reports without writing, then corrects with an audit event, then finds nothing to do', async () => {
    const { workspaceId, userId } = await freshWorkspace();
    await uploadFile(workspaceId, userId, photo(2 * MIB), null);
    await inWorkspace(workspaceId, (s) => initiate(s, userId, MIB)); // a PENDING session

    // Drift, as a pre-B-1 database held it: two per-file gigabytes, no bytes.
    await platform.usageCounter.updateMany({
      where: { workspaceId, featureKey: storageKey },
      data: { usedValue: 2, usedBytes: 0n },
    });

    const dry = await recomputeStorageUsage(platform, { apply: false, workspaceId });
    expect(dry).toEqual([
      {
        workspaceId,
        recordedBytes: 0n,
        recordedGb: 2,
        storedBytes: BigInt(3 * MIB),
        storedGb: 1,
      },
    ]);
    // The dry run wrote nothing.
    expect(await counter(workspaceId)).toEqual({ usedBytes: 0n, usedValue: 2 });

    const applied = await recomputeStorageUsage(platform, { apply: true, workspaceId });
    expect(applied).toHaveLength(1);
    expect(await counter(workspaceId)).toEqual({ usedBytes: BigInt(3 * MIB), usedValue: 1 });

    const audit = await platform.auditEvent.findFirst({
      where: { workspaceId, action: 'usage.storage_recomputed' },
    });
    expect(audit?.actorType).toBe('SYSTEM');
    expect(audit?.after).toEqual({ usedBytes: 3 * MIB, usedGb: 1 });

    expect(await recomputeStorageUsage(platform, { apply: false, workspaceId })).toEqual([]);
  });
});
