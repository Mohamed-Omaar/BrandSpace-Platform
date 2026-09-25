-- B-8 (docs/PROTOTYPE-V76-ALIGNMENT.md §1): Brand Brain source documents are
-- storage, and are now charged to the same `limit.storage_gb` byte meter as the
-- asset library (B-1). Documents uploaded before this change were never
-- charged, so every counter is RECOMPUTED here — assets, pending uploads AND
-- live source documents — rather than incremented. A full recompute is
-- idempotent and cannot double-count a workspace however the two migrations
-- were applied. `recomputeStorageUsage` (packages/entitlements) measures the
-- same three things.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. LIFT FORCE FOR THE BACKFILL, AND ONLY FOR THIS TRANSACTION.
--
-- The backfill reads every workspace's files and writes every workspace's
-- counter. Under FORCE the owner running this migration is subject to the
-- tenant policies, sees no workspace at all, and would silently backfill
-- nothing. Same remedy, and same guarantees, as the F-80 migration: `ALTER
-- TABLE` holds an ACCESS EXCLUSIVE lock until COMMIT, so no other session can
-- observe the lifted state — and no upload can move a counter between the
-- measurement and the write. A failure rolls the catalogue back with
-- everything else, and §4 proves FORCE is restored before COMMIT.
-- ---------------------------------------------------------------------------

ALTER TABLE "usage_counter"        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset"                NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset_version"        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset_upload_session" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_source_document" NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. MEASURE.
-- ---------------------------------------------------------------------------

CREATE TEMPORARY TABLE "b8_stored_bytes" ON COMMIT DROP AS
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
    UNION ALL
    SELECT d."workspaceId", d."byteSize"::bigint
      FROM "brand_source_document" d
     WHERE d."deletedAt" IS NULL
  ) t
 GROUP BY t."workspaceId";

-- ---------------------------------------------------------------------------
-- 3. WRITE. One row per workspace that stores anything; a counter whose
-- workspace stores nothing any more goes to zero.
-- ---------------------------------------------------------------------------

INSERT INTO "usage_counter"
  ("id", "workspaceId", "featureKey", "periodStart", "periodEnd",
   "usedValue", "usedBytes", "updatedAt")
SELECT gen_random_uuid(), s."workspaceId", 'limit.storage_gb',
       TIMESTAMPTZ '1970-01-01 00:00:00+00', TIMESTAMPTZ '9999-01-01 00:00:00+00',
       CEIL(s.bytes::numeric / 1073741824)::int, s.bytes, now()
  FROM "b8_stored_bytes" s
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
     SELECT 1 FROM "b8_stored_bytes" s
      WHERE s."workspaceId" = c."workspaceId" AND s.bytes > 0
   );

-- ---------------------------------------------------------------------------
-- 4. RESTORE FORCE, AND PROVE IT.
-- ---------------------------------------------------------------------------

ALTER TABLE "usage_counter"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset"                FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset_version"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "asset_upload_session" FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_source_document" FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  unprotected text;
BEGIN
  SELECT string_agg(relname, ', ' ORDER BY relname) INTO unprotected
  FROM pg_class
  WHERE relname IN ('usage_counter', 'asset', 'asset_version', 'asset_upload_session',
                    'brand_source_document')
    AND relkind = 'r'
    AND NOT (relrowsecurity AND relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'B-8 migration aborted: row-level security is not ENABLED and FORCED on %',
      unprotected;
  END IF;
END
$$;

COMMIT;
