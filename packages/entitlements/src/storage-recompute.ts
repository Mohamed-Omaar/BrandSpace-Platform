import { writeAuditEvent, type PrismaClient, type TenantScopedClient } from '@brandspace/database';
import { type Clock, systemClock } from '@brandspace/shared';
import { gigabytesFor, QUOTA_FEATURES, quotaWindow, type UsageTx } from './usage';

/**
 * Recompute every workspace's storage counter from what is actually stored — B-1.
 *
 * WHY THIS EXISTS. Until B-1 every upload was charged as a whole number of
 * gigabytes, rounded up per file, so the `limit.storage_gb` counters held sums
 * of roundings rather than anything a customer stored. That cannot be undone by
 * arithmetic on the counter: the per-file sizes are only recoverable from the
 * rows that describe the files. The B-1 migration (`20260925120000_storage_
 * bytes_meter`) does the one-time backfill itself, with the SAME definition of
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
 *     charged and `expireStaleSessions` or `complete` settles.
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

/** The SQL that decides "stored", for one workspace or for all of them. */
async function measureStoredBytes(
  db: UsageTx,
  workspaceId: string | null,
): Promise<Map<string, bigint>> {
  const rows = await db.$queryRaw<{ workspaceId: string; bytes: bigint | null }[]>`
    SELECT t."workspaceId"::text AS "workspaceId", SUM(t.bytes)::bigint AS bytes
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
      ) t
     WHERE ${workspaceId}::uuid IS NULL OR t."workspaceId" = ${workspaceId}::uuid
     GROUP BY t."workspaceId"`;
  return new Map(rows.map((row) => [row.workspaceId, BigInt(row.bytes ?? 0)]));
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
