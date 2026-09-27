import {
  Prisma,
  writeAuditEvent,
  type PrismaClient,
  type TenantScopedClient,
} from '@brandspace/database';
import { type Clock, systemClock } from '@brandspace/shared';
import { gigabytesFor, QUOTA_FEATURES, quotaWindow, type UsageTx } from './usage';

/**
 * Recompute every workspace's storage counter from what is actually stored — B-1.
 *
 * WHY THIS EXISTS. Until B-1 every upload was charged as a whole number of
 * gigabytes, rounded up per file, so the `limit.storage_gb` counters held sums
 * of roundings rather than anything a customer stored. That cannot be undone by
 * arithmetic on the counter: the per-file sizes are only recoverable from the
 * rows that describe the files. The B-1 and B-8 migrations
 * (`…_storage_bytes_meter`, `…_storage_bytes_brand_sources`) do the backfill, with the SAME definition of
 * "stored" as below, so no workspace starts at 0 bytes. This is the check that
 * can be run afterwards — dry run by default — and the repair for any drift
 * found later.
 *
 * WHAT COUNTS AS STORED — exactly what the product gives back later, so the
 * counter converges instead of drifting:
 *   - every distinct object behind a not-yet-purged asset (deleted assets
 *     inside their grace period still occupy storage, and `purgeDeletedAssets`
 *     refunds precisely these bytes — a restored version shares its object, so
 *     it is counted once);
 *   - the declared size of every PENDING upload session, which `initiate`
 *     charged and `expireStaleSessions` or `complete` settles;
 *   - every live Brand Brain source document (B-8), charged on upload.
 *
 * AND NOTHING ELSE. A version row that shares a restored object is the same
 * object and counts once; derivatives (thumbnails, previews) are not part of a
 * customer's storage quota, so they are neither charged, refunded, backfilled
 * nor counted here.
 *
 * IT DOES NOTHING UNLESS ASKED. `apply: false` (the default for the command)
 * only reports. With `apply: true` each workspace is corrected in its OWN
 * transaction, behind the counter row's lock — the same lock every upload
 * takes — so an upload cannot interleave between the measurement and the
 * write, and one failing workspace does not undo the others. Each correction
 * writes an audit event carrying the before and after totals.
 */

export interface StorageRecomputeRow {
  readonly workspaceId: string;
  readonly recordedBytes: bigint;
  readonly recordedGb: number;
  readonly storedBytes: bigint;
  readonly storedGb: number;
}

export interface StorageRecomputeOptions {
  readonly apply: boolean;
  /** Limit the run to one workspace — a spot check, or a re-run after a fix. */
  readonly workspaceId?: string;
  readonly clock?: Clock;
}

/**
 * THE ONE DEFINITION OF "STORED" — one row per stored object, tagged with
 * where it came from (C7, Phase 2B-2b).
 *
 * The meter SUMS these rows and the breakdown GROUPS them, so the two cannot
 * disagree about what is stored: there is no second query that could drift.
 * The tags are persisted columns only — `asset.kind` and `asset.source` for a
 * library file, and for the other two parts, the table the row lives in
 * (a PENDING upload session; a Brand Brain source document). Nothing is
 * inferred from a file name, a MIME type or a storage path.
 *
 * Adding the tags changes no total: `kind` and `source` belong to the asset,
 * so every version row of one asset carries the same pair and the
 * `DISTINCT ON (assetId, storageKey)` that counts a shared object once is
 * untouched.
 */
const STORED_OBJECTS = Prisma.sql`
  SELECT v."workspaceId", v."sizeBytes"::bigint AS bytes,
         'ASSET'::text AS category, v."kind"::text AS kind, v."source"::text AS source
    FROM (
      SELECT DISTINCT ON (av."assetId", av."storageKey")
             av."workspaceId", av."sizeBytes", a."kind", a."source"
        FROM "asset_version" av
        JOIN "asset" a
          ON a."id" = av."assetId" AND a."workspaceId" = av."workspaceId"
       WHERE a."storageKey" <> ''
    ) v
  UNION ALL
  SELECT s."workspaceId", s."declaredSizeBytes"::bigint,
         'UPLOADING'::text, NULL::text, NULL::text
    FROM "asset_upload_session" s
   WHERE s."status" = 'PENDING'
  UNION ALL
  SELECT d."workspaceId", d."byteSize"::bigint,
         'BRAND_BRAIN'::text, NULL::text, NULL::text
    FROM "brand_source_document" d
   WHERE d."deletedAt" IS NULL`;

/** The SQL that decides "stored", for one workspace or for all of them. */
async function measureStoredBytes(
  db: UsageTx,
  workspaceId: string | null,
): Promise<Map<string, bigint>> {
  const rows = await db.$queryRaw<{ workspaceId: string; bytes: bigint | null }[]>`
    SELECT t."workspaceId"::text AS "workspaceId", SUM(t.bytes)::bigint AS bytes
      FROM (${STORED_OBJECTS}) t
     WHERE ${workspaceId}::uuid IS NULL OR t."workspaceId" = ${workspaceId}::uuid
     GROUP BY t."workspaceId"`;
  return new Map(rows.map((row) => [row.workspaceId, BigInt(row.bytes ?? 0)]));
}

/** Where a workspace's stored bytes sit, grouped from the SAME rows the meter sums. */
export interface StorageBreakdownRow {
  /** `ASSET` a library file; `UPLOADING` a PENDING upload; `BRAND_BRAIN` a source document. */
  readonly category: 'ASSET' | 'UPLOADING' | 'BRAND_BRAIN';
  /** `asset.kind` for a library file; null for the other two, which store none. */
  readonly kind: string | null;
  /** `asset.source` for a library file; null for the other two. */
  readonly source: string | null;
  readonly bytes: bigint;
}

/**
 * C7 (Phase 2B-2b) — ONE WORKSPACE'S STORED BYTES, BY CATEGORY, KIND AND SOURCE.
 *
 * READ-ONLY and tenant-scoped: an explicit workspace predicate in the SQL
 * (CLAUDE.md §5) on top of RLS under the caller's client. It measures; it
 * writes nothing, and it does not touch the counter the meter shows — the
 * difference between the two, if any, is the caller's to present.
 */
export async function measureStorageBreakdown(
  db: UsageTx | TenantScopedClient,
  workspaceId: string,
): Promise<readonly StorageBreakdownRow[]> {
  const rows = await (db as UsageTx).$queryRaw<
    {
      category: StorageBreakdownRow['category'];
      kind: string | null;
      source: string | null;
      bytes: bigint | null;
    }[]
  >`
    SELECT t.category, t.kind, t.source, SUM(t.bytes)::bigint AS bytes
      FROM (${STORED_OBJECTS}) t
     WHERE t."workspaceId" = ${workspaceId}::uuid
     GROUP BY t.category, t.kind, t.source`;
  return rows.map((row) => ({
    category: row.category,
    kind: row.kind,
    source: row.source,
    bytes: BigInt(row.bytes ?? 0),
  }));
}

export async function recomputeStorageUsage(
  prisma: PrismaClient,
  options: StorageRecomputeOptions,
): Promise<StorageRecomputeRow[]> {
  const clock = options.clock ?? systemClock;
  const window = quotaWindow('total', clock.now());
  const featureKey = QUOTA_FEATURES.storageGb;

  const only = options.workspaceId ?? null;
  const stored = await measureStoredBytes(prisma, only);
  const counters = await prisma.usageCounter.findMany({
    where: { featureKey, periodStart: window.start, ...(only ? { workspaceId: only } : {}) },
    select: { workspaceId: true, usedBytes: true, usedValue: true },
  });
  const recorded = new Map(counters.map((c) => [c.workspaceId, c]));

  const workspaceIds = [...new Set([...stored.keys(), ...recorded.keys()])].sort();
  const drifted: StorageRecomputeRow[] = [];
  for (const workspaceId of workspaceIds) {
    const storedBytes = stored.get(workspaceId) ?? 0n;
    const counter = recorded.get(workspaceId);
    const recordedBytes = counter?.usedBytes ?? 0n;
    const storedGb = gigabytesFor(storedBytes);
    // A counter whose GIGABYTES disagree is drifted even when its bytes agree:
    // pre-B-1 rows carry a per-file-rounded `usedValue` beside 0 bytes.
    if (recordedBytes === storedBytes && (counter?.usedValue ?? 0) === storedGb) continue;
    drifted.push({
      workspaceId,
      recordedBytes,
      recordedGb: counter?.usedValue ?? 0,
      storedBytes,
      storedGb,
    });
  }

  if (!options.apply) return drifted;

  const applied: StorageRecomputeRow[] = [];
  for (const row of drifted) {
    applied.push(
      await prisma.$transaction(async (tx) => {
        // LOCK FIRST (create-or-lock, the same statement shape uploads use),
        // then measure, so the value written is the value behind the lock.
        const locked = await tx.$queryRaw<{ usedBytes: bigint; usedValue: number }[]>`
          INSERT INTO "usage_counter"
            ("id", "workspaceId", "featureKey", "periodStart", "periodEnd",
             "usedValue", "usedBytes", "updatedAt")
          VALUES
            (gen_random_uuid(), ${row.workspaceId}::uuid, ${featureKey},
             ${window.start}, ${window.end}, 0, 0, now())
          ON CONFLICT ("workspaceId", "featureKey", "periodStart")
          DO UPDATE SET "usedBytes" = "usage_counter"."usedBytes"
          RETURNING "usedBytes", "usedValue"`;
        const before = locked[0];
        const storedBytes =
          (await measureStoredBytes(tx, row.workspaceId)).get(row.workspaceId) ?? 0n;
        const storedGb = gigabytesFor(storedBytes);

        await tx.$executeRaw`
          UPDATE "usage_counter"
             SET "usedBytes" = ${storedBytes}::bigint,
                 "usedValue" = ${storedGb},
                 "updatedAt" = now()
           WHERE "workspaceId" = ${row.workspaceId}::uuid
             AND "featureKey"  = ${featureKey}
             AND "periodStart" = ${window.start}`;

        const recordedBytes = BigInt(before?.usedBytes ?? 0);
        const recordedGb = before?.usedValue ?? 0;
        await writeAuditEvent(tx as unknown as TenantScopedClient, row.workspaceId, {
          action: 'usage.storage_recomputed',
          actorType: 'SYSTEM',
          resourceType: 'UsageCounter',
          reason: 'B-1: storage metered in bytes; counter recomputed from stored files.',
          // Numbers, not bigints: JSON has no bigint, and no workspace holds
          // anywhere near 2^53 bytes.
          before: { usedBytes: Number(recordedBytes), usedGb: recordedGb },
          after: { usedBytes: Number(storedBytes), usedGb: storedGb },
        });

        return { workspaceId: row.workspaceId, recordedBytes, recordedGb, storedBytes, storedGb };
      }),
    );
  }
  return applied;
}

/** One line of a breakdown: a kind, a source, or one of the two other stores. */
export interface StorageBreakdownLine {
  readonly key: string;
  readonly bytes: bigint;
}

export interface StorageBreakdownView {
  /** Library files by `asset.kind`, then Brand Brain documents and uploads in progress. */
  readonly byKind: readonly StorageBreakdownLine[];
  /** Library files by `asset.source`, then the same two stores. */
  readonly bySource: readonly StorageBreakdownLine[];
  /** The meter (`usage_counter.usedBytes`) minus everything above, never below zero. */
  readonly other: bigint;
  /** Everything above, measured now from stored rows. */
  readonly measured: bigint;
  /** How far the measured total exceeds the meter — counter drift, shown as Other 0. */
  readonly drift: bigint;
}

const KIND_ORDER = ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'FONT'] as const;
const SOURCE_ORDER = ['UPLOAD', 'AI_GENERATED', 'IMPORTED'] as const;
const STORE_ORDER = ['BRAND_BRAIN', 'UPLOADING'] as const;

/**
 * C7 (Phase 2B-2b) — THE BREAKDOWN AS SHOWN, against the official meter.
 *
 * Both breakdowns account for the SAME measured rows, so each sums to the same
 * total. "Other" is the meter minus that total when the meter is larger — bytes
 * the meter counts that no stored row explains. When the measured total is
 * LARGER (the counter drifted below what is stored), Other is 0, never negative,
 * and the difference is returned as `drift` for the caller to report; the meter
 * itself is never changed here (`storage:recompute` is the repair, and it stays
 * a dry run unless an operator asks). A category with 0 bytes is not listed.
 */
export function storageBreakdownView(
  rows: readonly StorageBreakdownRow[],
  meterBytes: bigint,
): StorageBreakdownView {
  const sum = (predicate: (row: StorageBreakdownRow) => boolean): bigint =>
    rows.filter(predicate).reduce((total, row) => total + row.bytes, 0n);
  const stores = STORE_ORDER.map((key) => ({ key, bytes: sum((row) => row.category === key) }));
  const byKind = [
    ...KIND_ORDER.map((key) => ({
      key,
      bytes: sum((row) => row.category === 'ASSET' && row.kind === key),
    })),
    ...stores,
  ].filter((line) => line.bytes > 0n);
  const bySource = [
    ...SOURCE_ORDER.map((key) => ({
      key,
      bytes: sum((row) => row.category === 'ASSET' && row.source === key),
    })),
    ...stores,
  ].filter((line) => line.bytes > 0n);
  const measured = sum(() => true);
  return {
    byKind,
    bySource,
    other: meterBytes > measured ? meterBytes - measured : 0n,
    measured,
    drift: measured > meterBytes ? measured - meterBytes : 0n,
  };
}
