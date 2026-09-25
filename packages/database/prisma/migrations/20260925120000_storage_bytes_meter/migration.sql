-- B-1 (docs/PROTOTYPE-V76-ALIGNMENT.md §1): storage is metered in BYTES.
--
-- The storage quota used to round EVERY upload up to a whole gigabyte, so a
-- 1 MB photo cost 1 GB and five of them filled a 5 GB plan. From here on the
-- `limit.storage_gb` counter row carries the exact byte total in `usedBytes`,
-- which is the ONLY value upload admission compares against the plan's
-- gigabytes. `usedValue` on that row becomes the gigabytes the total occupies,
-- rounded up once, kept for display and reporting only.
--
-- THE BACKFILL IS HERE, in the same transaction as the new column, so no
-- existing workspace is ever observed at 0 bytes. It measures what is stored
-- exactly the way `recomputeStorageUsage` (packages/entitlements) does:
--   - every distinct object behind a not-yet-purged asset (a restored version
--     shares its object with the version it restored, so it counts once);
--   - the declared size of every PENDING upload session, which was charged at
--     initiate and is settled by completion or the expiry sweep.
-- `pnpm storage:recompute` remains available as a dry-run check afterwards.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. THE COLUMNS.
-- ---------------------------------------------------------------------------

ALTER TABLE "usage_counter" ADD COLUMN "usedBytes" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "usage_counter"
  ADD CONSTRAINT "usage_counter_used_bytes_non_negative" CHECK ("usedBytes" >= 0);

-- Signed: a refund records the negative of what it gives back. Null for every
-- unit quota; a byte movement records `amount` 0.
ALTER TABLE "usage_event" ADD COLUMN "bytes" BIGINT;

-- ---------------------------------------------------------------------------
-- 2. LIFT FORCE FOR THE BACKFILL, AND ONLY FOR THIS TRANSACTION.
--
-- The backfill reads every workspace's files and writes every workspace's
-- counter. Under FORCE the owner running this migration is subject to the
-- tenant policies, sees no workspace at all, and would silently backfill
-- nothing. Same remedy, and same guarantees, as the F-80 migration: `ALTER
-- TABLE` holds an ACCESS EXCLUSIVE lock until COMMIT, so no other session can
-- observe the lifted state — and no upload can move a counter between the
-- measurement and the write. A failure rolls the catalogue back with
-- everything else, and §5 proves FORCE is restored before COMMIT.
-- ---------------------------------------------------------------------------

ALTER TABLE "usage_counter"        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset"                NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset_version"        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset_upload_session" NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. MEASURE.
-- ---------------------------------------------------------------------------

CREATE TEMPORARY TABLE "b1_stored_bytes" ON COMMIT DROP AS
SELECT t."workspaceId", SUM(t.bytes)::bigint AS bytes
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
 GROUP BY t."workspaceId";

-- ---------------------------------------------------------------------------
-- 4. WRITE. One row per workspace that stores anything; a counter whose
-- workspace stores nothing any more goes to zero.
-- ---------------------------------------------------------------------------

INSERT INTO "usage_counter"
  ("id", "workspaceId", "featureKey", "periodStart", "periodEnd",
   "usedValue", "usedBytes", "updatedAt")
SELECT gen_random_uuid(), s."workspaceId", 'limit.storage_gb',
       TIMESTAMPTZ '1970-01-01 00:00:00+00', TIMESTAMPTZ '9999-01-01 00:00:00+00',
       CEIL(s.bytes::numeric / 1073741824)::int, s.bytes, now()
  FROM "b1_stored_bytes" s
 WHERE s.bytes > 0
ON CONFLICT ("workspaceId", "featureKey", "periodStart")
DO UPDATE SET "usedBytes" = EXCLUDED."usedBytes",
              "usedValue" = EXCLUDED."usedValue",
              "updatedAt" = now();

UPDATE "usage_counter" c
   SET "usedBytes" = 0, "usedValue" = 0, "updatedAt" = now()
 WHERE c."featureKey" = 'limit.storage_gb'
   AND c."periodStart" = TIMESTAMPTZ '1970-01-01 00:00:00+00'
   AND NOT EXISTS (
     SELECT 1 FROM "b1_stored_bytes" s
      WHERE s."workspaceId" = c."workspaceId" AND s.bytes > 0
   );

-- ---------------------------------------------------------------------------
-- 5. RESTORE FORCE, AND PROVE IT.
-- ---------------------------------------------------------------------------

ALTER TABLE "usage_counter"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset"                FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset_version"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset_upload_session" FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  unprotected text;
BEGIN
  SELECT string_agg(relname, ', ' ORDER BY relname) INTO unprotected
  FROM pg_class
  WHERE relname IN ('usage_counter', 'asset', 'asset_version', 'asset_upload_session')
    AND relkind = 'r'
    AND NOT (relrowsecurity AND relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'B-1 migration aborted: row-level security is not ENABLED and FORCED on %',
      unprotected;
  END IF;
END
$$;

COMMIT;
