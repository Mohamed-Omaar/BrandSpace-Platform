-- Phase 6, second review pass: the pending grant and its target selection.
--
-- WHY A SECOND MIGRATION RATHER THAN AN EDIT TO THE FIRST. 20260916120000 has
-- been applied — by CI, and by anyone who checked this branch out and ran the
-- suite. Editing an applied migration in place gives every one of those
-- databases silent drift that `migrate deploy` will never repair, and Prisma
-- records the checksum precisely so that cannot pass unnoticed. Forward-only is
-- the only safe direction once a migration has run anywhere.
--
-- WHAT IT ADDS, and why the columns exist at all (D-142): a grant that offers
-- more than one page, channel or organization is NOT finished at the callback.
-- The first implementation took `targets[0]` and persisted an ACTIVE connection
-- to it, which decides on the customer's behalf which of their pages BrandSpace
-- may post to. It now pauses: the exchanged token is sealed onto the in-flight
-- authorization row, the offered targets are recorded, and a single-use
-- selection secret is minted for the browser that completed the callback.
--
-- THE TOKEN IS SEALED, NOT STORED. These columns hold exactly what
-- `social_credential` holds — an AES-256-GCM envelope with a wrapped data key
-- and an authenticated context — under the SOCIAL token key domain (D-136).
-- A pending grant is a live credential and is protected as one.
--
-- D-113: Prisma does not wrap a migration file in a transaction, so this one
-- wraps itself. Every statement below lands together or none of them does.

BEGIN;

-- ---------------------------------------------------------------------------
-- The sealed pending grant.
-- ---------------------------------------------------------------------------

ALTER TABLE "social_oauth_state"
  ADD COLUMN "pendingCiphertext"        TEXT,
  ADD COLUMN "pendingIv"                TEXT,
  ADD COLUMN "pendingAuthTag"           TEXT,
  ADD COLUMN "pendingWrappedDataKey"    TEXT,
  ADD COLUMN "pendingKeyProvider"       TEXT,
  ADD COLUMN "pendingKeyId"             TEXT,
  ADD COLUMN "pendingEncryptionContext" TEXT,
  ADD COLUMN "offeredTargets"           JSONB,
  ADD COLUMN "grantedScopes"            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "selectionTokenHash"       TEXT,
  ADD COLUMN "selectionExpiresAt"       TIMESTAMPTZ(6),
  ADD COLUMN "selectionConsumedAt"      TIMESTAMPTZ(6);

-- UNIQUE PLATFORM-WIDE, for the same reason `stateHash` is: two workspaces must
-- not be able to collide, and a selection secret must resolve to exactly one
-- row or to none.
CREATE UNIQUE INDEX "social_oauth_state_selectionTokenHash_key"
  ON "social_oauth_state" ("selectionTokenHash");

-- ---------------------------------------------------------------------------
-- The pending grant is all-or-nothing.
-- ---------------------------------------------------------------------------
--
-- A row carrying a selection secret but no sealed token would be a selection
-- that cannot complete; a row carrying a sealed token but no secret would be a
-- token nobody can reach and nobody can revoke. The constraint makes both
-- unrepresentable rather than merely unlikely.

ALTER TABLE "social_oauth_state"
  ADD CONSTRAINT "social_oauth_state_pending_grant_is_whole" CHECK (
    (
      "selectionTokenHash" IS NULL
      AND "pendingCiphertext" IS NULL
      AND "pendingIv" IS NULL
      AND "pendingAuthTag" IS NULL
      AND "pendingWrappedDataKey" IS NULL
      AND "pendingKeyProvider" IS NULL
      AND "pendingKeyId" IS NULL
      AND "pendingEncryptionContext" IS NULL
      AND "offeredTargets" IS NULL
      AND "selectionExpiresAt" IS NULL
    )
    OR (
      "selectionTokenHash" IS NOT NULL
      AND "pendingCiphertext" IS NOT NULL
      AND "pendingIv" IS NOT NULL
      AND "pendingAuthTag" IS NOT NULL
      AND "pendingWrappedDataKey" IS NOT NULL
      AND "pendingKeyProvider" IS NOT NULL
      AND "pendingKeyId" IS NOT NULL
      AND "pendingEncryptionContext" IS NOT NULL
      AND "offeredTargets" IS NOT NULL
      AND "selectionExpiresAt" IS NOT NULL
    )
  );

-- ---------------------------------------------------------------------------
-- Recovering a job whose worker died mid-flight.
-- ---------------------------------------------------------------------------
--
-- D-143. `execute()` moves a job to PUBLISHING before the external call, which
-- is the correct order: if the process dies between the two, the row already
-- says "we may have sent this". But the reconciliation sweep only ever
-- dispatched QUEUED jobs, so such a row stayed PUBLISHING for ever with nothing
-- looking at it.
--
-- The recovery rule keys off `claimedAt`, which the claim already writes, so no
-- column is added. What IS added is the index that makes the sweep a lookup
-- rather than a scan of every publishing job in the platform.

CREATE INDEX "publish_job_status_claimedAt_idx"
  ON "publish_job" ("status", "claimedAt");

-- ---------------------------------------------------------------------------
-- Assert the outcome before committing.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(needed, ', ')
    INTO missing
    FROM unnest(ARRAY[
      'pendingCiphertext', 'pendingIv', 'pendingAuthTag', 'pendingWrappedDataKey',
      'pendingKeyProvider', 'pendingKeyId', 'pendingEncryptionContext',
      'offeredTargets', 'grantedScopes',
      'selectionTokenHash', 'selectionExpiresAt', 'selectionConsumedAt'
    ]) AS needed
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'social_oauth_state'
        AND column_name = needed
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'social_oauth_state is missing the pending-grant columns: %', missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'social_oauth_state_pending_grant_is_whole'
  ) THEN
    RAISE EXCEPTION 'the pending-grant wholeness constraint was not installed.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'publish_job_status_claimedAt_idx'
  ) THEN
    RAISE EXCEPTION 'the stale-claim recovery index was not installed.';
  END IF;

  -- RLS IS NOT RE-DECLARED HERE AND MUST NOT HAVE BEEN DISTURBED. Adding a
  -- column does not touch a policy, but asserting it costs nothing and this is
  -- the file that would be blamed if it had.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname = 'social_oauth_state' AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'social_oauth_state lost ENABLE + FORCE row-level security.';
  END IF;
END $$;

COMMIT;
