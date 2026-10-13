-- Connectors step B (D-505, approved by the owner as written) — B1 of 3:
-- the inbound-event and data-deletion tables.
--
-- PLATFORM-OWNED (no workspaceId): Meta's callbacks arrive with no tenant, and
-- one deauthorization or deletion can concern connections in several
-- workspaces. The tenant role gets nothing on them: RLS enabled and forced, a
-- platform_only policy, REVOKE ALL from brandspace_app, and a self-check that
-- fails the migration if either table is reachable by the tenant role
-- (exactly as billing_event, Phase 9).
--
-- FORWARD-ONLY and additive: no existing row, column, policy or grant changes.
-- Retention of social_inbound_event rows is configuration
-- (`publishing.inbound.retentionDays`), purged by the maintenance sweep.
--
-- What it is for:
--   social_inbound_event          — every VERIFIED delivery from a platform:
--                                   a webhook (X-Hub-Signature-256 checked over
--                                   the raw body), a deauthorize callback or a
--                                   data-deletion callback (signed_request
--                                   checked). A row exists only after the
--                                   signature was verified; an unsigned or
--                                   badly signed request writes nothing.
--                                   `dedupeKey` (sha256 of the raw body) makes a
--                                   redelivery collide and change nothing.
--                                   Processing uses the billing_event claim
--                                   pattern (D-221): status + claimToken +
--                                   claimedAt, one winner per delivery.
--   social_data_deletion_request  — what Meta's data-deletion callback must
--                                   answer with: a confirmation code and a
--                                   status URL the person can open. Keeps the
--                                   versioned subject HASH only (W10), never
--                                   the platform's user id. Survives the
--                                   inbound event's retention purge
--                                   (inboundEventId ON DELETE SET NULL).
-- No payload ever holds a token, a secret or the raw platform user id; the
-- normalised payload is bounded to 64 KiB.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TYPE "SocialInboundEventKind" AS ENUM ('WEBHOOK', 'DEAUTHORIZE', 'DATA_DELETION');

CREATE TYPE "SocialInboundEventStatus" AS ENUM (
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'IGNORED',
  'FAILED'
);

CREATE TYPE "SocialDataDeletionStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'COMPLETED');

CREATE TABLE "social_inbound_event" (
  "id"              UUID                       NOT NULL,
  "provider"        "SocialProvider"           NOT NULL,
  "kind"            "SocialInboundEventKind"   NOT NULL,
  "dedupeKey"       TEXT                       NOT NULL,
  -- The granting user, as W10's versioned keyed hash; deauthorize and deletion only.
  "subjectHash"     TEXT,
  -- The normalised event (object, entry ids, fields, the media/container id a
  -- publish is waiting on). Never tokens, never the raw platform user id.
  "payload"         JSONB                      NOT NULL,
  -- The platform's own timestamp when it sends one.
  "occurredAt"      TIMESTAMPTZ(6),
  "status"          "SocialInboundEventStatus" NOT NULL DEFAULT 'RECEIVED',
  "attempts"        INTEGER                    NOT NULL DEFAULT 0,
  "claimToken"      UUID,
  "claimedAt"       TIMESTAMPTZ(6),
  -- A machine code only (e.g. `connection_not_found`), never provider text.
  "failureCode"     TEXT,
  "receivedAt"      TIMESTAMPTZ(6)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"     TIMESTAMPTZ(6),

  CONSTRAINT "social_inbound_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_inbound_event_dedupe_key_shape"
    CHECK ("dedupeKey" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "social_inbound_event_subject_hash_shape"
    CHECK ("subjectHash" IS NULL OR "subjectHash" ~ '^v[0-9]{1,4}:[0-9a-f]{64}$'),
  -- Deauthorize and deletion always name a subject; a webhook never needs one.
  CONSTRAINT "social_inbound_event_subject_for_kind"
    CHECK (("kind" = 'WEBHOOK') OR ("subjectHash" IS NOT NULL)),
  CONSTRAINT "social_inbound_event_payload_object"
    CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "social_inbound_event_payload_size"
    CHECK (pg_column_size("payload") <= 65536),
  CONSTRAINT "social_inbound_event_attempts_range"
    CHECK ("attempts" BETWEEN 0 AND 100),
  -- A claim is a token and a time together, and only while PROCESSING.
  CONSTRAINT "social_inbound_event_claim_shape"
    CHECK (
      ("status" = 'PROCESSING') = ("claimToken" IS NOT NULL)
      AND ("claimToken" IS NULL) = ("claimedAt" IS NULL)
    ),
  CONSTRAINT "social_inbound_event_failure_code_shape"
    CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[a-z0-9_.]{1,100}$'),
  CONSTRAINT "social_inbound_event_processed_at"
    CHECK (("status" IN ('PROCESSED', 'IGNORED', 'FAILED')) = ("processedAt" IS NOT NULL))
);

-- A redelivery of the same body is the same row (the idempotency key).
CREATE UNIQUE INDEX "social_inbound_event_provider_kind_dedupeKey_key"
  ON "social_inbound_event" ("provider", "kind", "dedupeKey");
-- The processing sweep: what is waiting, oldest first.
CREATE INDEX "social_inbound_event_status_receivedAt_idx"
  ON "social_inbound_event" ("status", "receivedAt");
-- A stuck claim, past its lease.
CREATE INDEX "social_inbound_event_status_claimedAt_idx"
  ON "social_inbound_event" ("status", "claimedAt");

CREATE TABLE "social_data_deletion_request" (
  "id"                 UUID                       NOT NULL,
  "provider"           "SocialProvider"           NOT NULL,
  -- Shown to the person and to Meta; random, URL-safe, never derived from the subject.
  "confirmationCode"   TEXT                       NOT NULL,
  "subjectHash"        TEXT                       NOT NULL,
  "inboundEventId"     UUID,
  "status"             "SocialDataDeletionStatus" NOT NULL DEFAULT 'RECEIVED',
  "connectionsFound"   INTEGER                    NOT NULL DEFAULT 0,
  "connectionsDeleted" INTEGER                    NOT NULL DEFAULT 0,
  "requestedAt"        TIMESTAMPTZ(6)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"        TIMESTAMPTZ(6),

  CONSTRAINT "social_data_deletion_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "social_data_deletion_request_code_shape"
    CHECK ("confirmationCode" ~ '^[A-Za-z0-9]{20,64}$'),
  CONSTRAINT "social_data_deletion_request_subject_hash_shape"
    CHECK ("subjectHash" ~ '^v[0-9]{1,4}:[0-9a-f]{64}$'),
  CONSTRAINT "social_data_deletion_request_counts"
    CHECK ("connectionsFound" >= 0 AND "connectionsDeleted" BETWEEN 0 AND "connectionsFound"),
  CONSTRAINT "social_data_deletion_request_completed_at"
    CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)),
  CONSTRAINT "social_data_deletion_request_inbound_event_fkey"
    FOREIGN KEY ("inboundEventId") REFERENCES "social_inbound_event" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- The status page looks a request up by its code.
CREATE UNIQUE INDEX "social_data_deletion_request_confirmationCode_key"
  ON "social_data_deletion_request" ("confirmationCode");
-- One request per delivery: a redelivered callback returns the same code.
CREATE UNIQUE INDEX "social_data_deletion_request_inboundEventId_key"
  ON "social_data_deletion_request" ("inboundEventId");
-- Every request for one person (repeat requests, support questions).
CREATE INDEX "social_data_deletion_request_provider_subjectHash_idx"
  ON "social_data_deletion_request" ("provider", "subjectHash");
-- The processing sweep.
CREATE INDEX "social_data_deletion_request_status_requestedAt_idx"
  ON "social_data_deletion_request" ("status", "requestedAt");

-- PLATFORM ONLY. A workspace must not read, count or infer another workspace's
-- (or anyone's) inbound deliveries or deletion requests.
ALTER TABLE "social_inbound_event"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_inbound_event"         FORCE  ROW LEVEL SECURITY;
ALTER TABLE "social_data_deletion_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "social_data_deletion_request" FORCE  ROW LEVEL SECURITY;

CREATE POLICY platform_only ON "social_inbound_event"
  TO brandspace_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_only ON "social_data_deletion_request"
  TO brandspace_platform USING (true) WITH CHECK (true);

-- The schema's default privileges grant every new table to the tenant role;
-- these two are taken back from it.
REVOKE ALL ON "social_inbound_event"         FROM brandspace_app;
REVOKE ALL ON "social_data_deletion_request" FROM brandspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "social_inbound_event"         TO brandspace_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "social_data_deletion_request" TO brandspace_platform;

-- PROVE IT: RLS enabled and forced, and the tenant role holds no privilege.
DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(name, ', ') INTO bad
    FROM unnest(ARRAY['social_inbound_event', 'social_data_deletion_request']) AS name
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_class
            WHERE relname = name AND relnamespace = 'public'::regnamespace
              AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity)
      OR has_table_privilege('brandspace_app', 'public.' || name, 'SELECT, INSERT, UPDATE, DELETE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'connectors B: not platform-only: %', bad;
  END IF;
END
$$;

COMMIT;
