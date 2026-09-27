import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { AssetLibraryService, assetPolicyFrom, type AssetActor } from '@brandspace/assets';
import { defaultPayload } from '@brandspace/config';
import {
  QUOTA_FEATURES,
  measureStorageBreakdown,
  recomputeStorageUsage,
  storageBreakdownView,
} from '@brandspace/entitlements';
import { WORKSPACE_PERMISSIONS } from '@brandspace/shared';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * C7 (Phase 2B-2b) — THE STORAGE BREAKDOWN AND THE LIBRARY COUNT, AGAINST REAL
 * POSTGRESQL.
 *
 *   1. The breakdown groups EXACTLY the rows the meter sums: its total equals
 *      the pre-Phase-2B-2b meter SQL, run verbatim, so B-1/B-8 accounting did
 *      not move.
 *   2. Kind and source come from `asset.kind` / `asset.source`; Brand Brain
 *      documents and PENDING uploads are their own categories; nothing is
 *      inferred from a name or a MIME type.
 *   3. Another workspace's bytes never appear.
 *   4. "M" in "Latest 48 of M" is the SAME filtered, brand-scoped set as the
 *      list, and `storage:recompute` still writes nothing unless asked.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let workspaceId: string;
let userId: string;
let brandId: string;
let otherBrandId: string;

/** THE METER'S SQL AS IT STOOD BEFORE PHASE 2B-2b, verbatim — the reference. */
async function legacyMeter(id: string): Promise<bigint> {
  const rows = await platform.$queryRaw<{ bytes: bigint | null }[]>`
    SELECT SUM(t.bytes)::bigint AS bytes
      FROM (
        SELECT v."workspaceId", v."sizeBytes"::bigint AS bytes
          FROM (
            SELECT DISTINCT ON (av."assetId", av."storageKey")
                   av."workspaceId", av."sizeBytes"
              FROM "asset_version" av
              JOIN "asset" a
                ON a."id" = av."assetId" AND a."workspaceId" = av."workspaceId"
             WHERE a."storageKey" <> ''
          ) v
        UNION ALL
        SELECT s."workspaceId", s."declaredSizeBytes"::bigint
          FROM "asset_upload_session" s
         WHERE s."status" = 'PENDING'
        UNION ALL
        SELECT d."workspaceId", d."byteSize"::bigint
          FROM "brand_source_document" d
         WHERE d."deletedAt" IS NULL
      ) t
     WHERE t."workspaceId" = ${id}::uuid`;
  return BigInt(rows[0]?.bytes ?? 0);
}

async function asset(input: {
  kind: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  source: 'UPLOAD' | 'AI_GENERATED';
  bytes: number;
  brand?: string | null;
  versions?: number;
  purged?: boolean;
  name?: string;
}): Promise<string> {
  const key = `bk/${randomUUID()}`;
  const row = await platform.asset.create({
    data: {
      workspaceId,
      brandId: input.brand === undefined ? brandId : input.brand,
      // A misleading name and MIME type: classification must ignore both.
      name: input.name ?? 'holiday.mp4',
      kind: input.kind,
      mimeType: 'application/octet-stream',
      sizeBytes: input.bytes,
      storageKey: input.purged ? '' : key,
      checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      status: 'READY',
      scanStatus: 'CLEAN',
      source: input.source,
    } as never,
    select: { id: true },
  });
  for (let version = 1; version <= (input.versions ?? 1); version += 1) {
    await platform.assetVersion.create({
      data: {
        workspaceId,
        assetId: row.id,
        versionNumber: version,
        // Version 2 is a RESTORE of version 1: the same object, counted once.
        storageKey: key,
        mimeType: 'application/octet-stream',
        sizeBytes: input.bytes,
        checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        createdByUserId: userId,
      } as never,
    });
  }
  return row.id;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  // A workspace of its own, so the fixture rows every suite shares do not move the totals.
  workspaceId = randomUUID();
  userId = (
    await platform.user.create({
      data: { email: `c7-${randomUUID()}@example.test`, timezone: 'UTC', status: 'ACTIVE' },
      select: { id: true },
    })
  ).id;
  await platform.workspace.create({
    data: {
      id: workspaceId,
      workspaceId,
      slug: `c7-${workspaceId.slice(0, 12)}`,
      name: 'C7',
      ownerUserId: userId,
      status: 'ACTIVE',
      country: 'SA',
      currency: 'SAR',
      defaultLocale: 'EN',
      timezone: 'UTC',
    },
  });
  for (const name of ['c7-a', 'c7-b']) {
    const created = await platform.brand.create({
      data: { workspaceId, slug: `${name}-${randomUUID().slice(0, 6)}`, name, status: 'ACTIVE' },
      select: { id: true },
    });
    if (name === 'c7-a') brandId = created.id;
    else otherBrandId = created.id;
  }

  await asset({ kind: 'IMAGE', source: 'UPLOAD', bytes: 1_000 });
  await asset({ kind: 'IMAGE', source: 'AI_GENERATED', bytes: 2_000, versions: 2 });
  await asset({ kind: 'VIDEO', source: 'UPLOAD', bytes: 5_000, brand: otherBrandId });
  await asset({ kind: 'DOCUMENT', source: 'UPLOAD', bytes: 300, brand: null });
  // Purged: its object is gone and the meter no longer counts it.
  await asset({ kind: 'VIDEO', source: 'UPLOAD', bytes: 9_999, purged: true });
  await platform.assetUploadSession.create({
    data: {
      workspaceId,
      declaredFileName: 'big.png',
      declaredMimeType: 'image/png',
      declaredSizeBytes: 700,
      storageKey: `up/${randomUUID()}`,
      idempotencyKey: `c7-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      status: 'PENDING',
      createdByUserId: userId,
    } as never,
  });
  await platform.brandSourceDocument.create({
    data: {
      workspaceId,
      brandId,
      fileName: 'guidelines.pdf',
      mimeType: 'application/pdf',
      byteSize: 400,
      checksum: randomUUID(),
      storageKey: `bb/${randomUUID()}`,
      idempotencyKey: `c7-${randomUUID()}`,
      uploadedByUserId: userId,
    } as never,
  });
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

const breakdown = (id = workspaceId) =>
  withWorkspace(id, (db: TenantScopedClient) => measureStorageBreakdown(db, id), {
    prisma: app,
  });

describe('the breakdown is the meter, grouped', () => {
  it('sums to exactly what the meter’s pre-Phase-2B-2b SQL measures', async () => {
    const rows = await breakdown();
    const total = rows.reduce((sum, row) => sum + row.bytes, 0n);
    expect(total).toBe(await legacyMeter(workspaceId));
    // 1000 + 2000 (two versions, one object) + 5000 + 300 + 700 + 400.
    expect(total).toBe(9_400n);
  });

  it('classifies by persisted columns and tables only', async () => {
    const view = storageBreakdownView(await breakdown(), 9_400n);
    expect(view.byKind).toEqual([
      { key: 'IMAGE', bytes: 3_000n },
      { key: 'VIDEO', bytes: 5_000n },
      { key: 'DOCUMENT', bytes: 300n },
      { key: 'BRAND_BRAIN', bytes: 400n },
      { key: 'UPLOADING', bytes: 700n },
    ]);
    expect(view.bySource).toEqual([
      { key: 'UPLOAD', bytes: 6_300n },
      { key: 'AI_GENERATED', bytes: 2_000n },
      { key: 'BRAND_BRAIN', bytes: 400n },
      { key: 'UPLOADING', bytes: 700n },
    ]);
    expect(view.other).toBe(0n);
  });

  it('never shows another workspace’s bytes', async () => {
    const own = await breakdown(fixtures.a.workspaceId);
    const total = own.reduce((sum, row) => sum + row.bytes, 0n);
    expect(total).toBe(await legacyMeter(fixtures.a.workspaceId));
    // Asked for THIS workspace under another workspace's session: RLS returns nothing.
    const crossed = await withWorkspace(
      fixtures.b.workspaceId,
      (db: TenantScopedClient) => measureStorageBreakdown(db, workspaceId),
      { prisma: app },
    );
    expect(crossed).toEqual([]);
  });

  it('storage:recompute still measures without writing unless asked', async () => {
    await platform.usageCounter.deleteMany({
      where: { workspaceId, featureKey: QUOTA_FEATURES.storageGb },
    });
    const drifted = await recomputeStorageUsage(platform, { apply: false, workspaceId });
    expect(drifted.map((row) => row.storedBytes)).toEqual([9_400n]);
    expect(
      await platform.usageCounter.count({
        where: { workspaceId, featureKey: QUOTA_FEATURES.storageGb },
      }),
    ).toBe(0);
  });
});

describe('"Latest 48 of M files" counts the same filtered, brand-scoped set', () => {
  const policy = assetPolicyFrom(defaultPayload('assets'));
  const actor = (brandScope: string[] = []): AssetActor => ({
    userId,
    permissionKeys: WORKSPACE_PERMISSIONS.map((permission) => permission.key),
    brandScope,
  });
  const browse = (input: Parameters<AssetLibraryService['browse']>[0]) =>
    withWorkspace(
      workspaceId,
      (db: TenantScopedClient) =>
        new AssetLibraryService({ db, workspaceId, policy }).browse(input),
      { prisma: app },
    );

  it('M is every match, not just this page, and follows the filters', async () => {
    const all = await browse({ actor: actor(), limit: 1, withTotal: true });
    expect(all.items).toHaveLength(1);
    // Every asset row the list could show — the purged one included: its object
    // is gone (the meter no longer counts it) but the library row is not deleted.
    expect(all.total).toBe(5);
    const images = await browse({ actor: actor(), kinds: ['IMAGE'], withTotal: true });
    expect(images.total).toBe(2);
    const ai = await browse({ actor: actor(), sources: ['AI_GENERATED'], withTotal: true });
    expect(ai.total).toBe(1);
  });

  it('a member of one brand counts only what they can list', async () => {
    const scoped = await browse({ actor: actor([brandId]), withTotal: true });
    const listed = await browse({ actor: actor([brandId]), limit: 100 });
    expect(scoped.total).toBe(listed.items.length);
    expect(scoped.total).toBeLessThan(
      (await browse({ actor: actor(), withTotal: true })).total ?? 0,
    );
  });

  it('without asking, nothing is counted', async () => {
    expect((await browse({ actor: actor() })).total).toBeNull();
  });
});
