-- ---------------------------------------------------------------------------
-- PR B — ONE ASSISTANT, ONE CONTINUOUS CONVERSATION PER PERSON PER BRAND.
--
-- Brand Brain chat and the Copilot become one assistant ("Copilot" /
-- «المساعد») built on `copilot_session`. There is ONE session per
-- (workspace, person, brand) — enforced below by a unique index — and every
-- existing Copilot session and Brand Brain conversation of that person and
-- brand is merged into it, messages in time order.
--
-- WHAT CHANGES
--   copilot_session  + summary, summaryThroughAt, summaryExpiresAt,
--                      summaryPurgedAt   (the rolling summary of older turns:
--                      customer content, purged by retention like a body)
--   copilot_message  + kind ('message' | 'topic_break'), status ('streaming' |
--                      'complete' | 'stopped' | 'failed'), citations,
--                      insufficientKnowledge
--   copilot_session  UNIQUE (workspaceId, userId, brandId) NULLS NOT DISTINCT
--                    WHERE archivedAt IS NULL — one ACTIVE conversation
--
-- CONFIRMED PLANS ARE NOT TOUCHED. `copilot_plan_frozen_once_confirmed`
-- forbids changing a confirmed plan's planVersion, and plan versions are
-- unique per session, so plans cannot move into the merged session. They stay
-- on the session they were made in, which is ARCHIVED (not deleted): its
-- plans, tool calls, confirmations and audit trail remain whole. Only the
-- TURNS move; a moved turn keeps pointing at its plan (FK on workspaceId,
-- planId, which does not involve the session).
--
-- brand_brain_conversation / brand_brain_message are READ, never changed: their
-- rows stay as they are, unused by the product; dropping them is a later,
-- separately approved migration.
--
-- FORCE ROW LEVEL SECURITY (D-113). All four tables touched here have FORCE RLS
-- and the migrator role is NOBYPASSRLS, so under FORCE this data step would
-- see ZERO rows and merge nothing. The repo's documented pattern
-- (20260914200000 §0, 20260915234500, tests/isolation/d112-migration-atomicity)
-- is followed: an explicit BEGIN/COMMIT (Prisma does not wrap a migration
-- file in a transaction), NO FORCE for the duration, FORCE restored before
-- COMMIT. A failure anywhere rolls back everything, NO FORCE included.
-- ENABLE ROW LEVEL SECURITY and every policy are untouched; the app and
-- platform roles are unaffected throughout.
--
-- RE-RUNNABLE. Every DDL statement is IF NOT EXISTS / guarded, and the data
-- steps only act on what is not merged yet: running the file twice changes
-- nothing (tests/isolation/pr-b-one-assistant-migration.test.ts).
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE "copilot_session"          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "copilot_message"          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_conversation" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_message"      NO FORCE ROW LEVEL SECURITY;

-- 1. COLUMNS ------------------------------------------------------------------

ALTER TABLE "copilot_session"
  ADD COLUMN IF NOT EXISTS "summary"          TEXT,
  ADD COLUMN IF NOT EXISTS "summaryThroughAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "summaryExpiresAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "summaryPurgedAt"  TIMESTAMPTZ(6);

ALTER TABLE "copilot_message"
  ADD COLUMN IF NOT EXISTS "kind"                  TEXT    NOT NULL DEFAULT 'message',
  ADD COLUMN IF NOT EXISTS "status"                TEXT    NOT NULL DEFAULT 'complete',
  ADD COLUMN IF NOT EXISTS "citations"             JSONB,
  ADD COLUMN IF NOT EXISTS "insufficientKnowledge" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "copilot_session" DROP CONSTRAINT IF EXISTS "copilot_session_summary_purge_is_recorded";
ALTER TABLE "copilot_session" ADD CONSTRAINT "copilot_session_summary_purge_is_recorded"
  CHECK ("summaryPurgedAt" IS NULL OR "summary" IS NULL);

ALTER TABLE "copilot_message" DROP CONSTRAINT IF EXISTS "copilot_message_kind_check";
ALTER TABLE "copilot_message" ADD CONSTRAINT "copilot_message_kind_check"
  CHECK ("kind" IN ('message', 'topic_break'));

-- A "New topic" divider carries no words.
ALTER TABLE "copilot_message" DROP CONSTRAINT IF EXISTS "copilot_message_topic_break_is_empty";
ALTER TABLE "copilot_message" ADD CONSTRAINT "copilot_message_topic_break_is_empty"
  CHECK ("kind" = 'message' OR "body" IS NULL);

ALTER TABLE "copilot_message" DROP CONSTRAINT IF EXISTS "copilot_message_status_check";
ALTER TABLE "copilot_message" ADD CONSTRAINT "copilot_message_status_check"
  CHECK ("status" IN ('streaming', 'complete', 'stopped', 'failed'));

-- 2. THE ONE SESSION PER (workspace, person, brand) ----------------------------
--
-- The canonical session of a group is its EARLIEST Copilot session (createdAt,
-- then id), archived or not; a group with only Brand Brain conversations gets a
-- new session that reuses its earliest conversation's id. A conversation with
-- no starter (`startedByUserId` NULL) has no owner and is not merged.

INSERT INTO "copilot_session"
  ("id", "workspaceId", "brandId", "userId", "surface", "locale",
   "lastMessageAt", "createdAt", "updatedAt")
SELECT DISTINCT ON (c."workspaceId", c."startedByUserId", c."brandId")
       c."id", c."workspaceId", c."brandId", c."startedByUserId", 'general', 'EN',
       c."lastMessageAt", c."createdAt", now()
FROM "brand_brain_conversation" c
WHERE c."startedByUserId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "copilot_session" s
    WHERE s."workspaceId" = c."workspaceId"
      AND s."userId" = c."startedByUserId"
      AND s."brandId" IS NOT DISTINCT FROM c."brandId")
ORDER BY c."workspaceId", c."startedByUserId", c."brandId", c."createdAt", c."id"
ON CONFLICT ("id") DO NOTHING;

CREATE TEMP TABLE pb_canonical ON COMMIT DROP AS
SELECT DISTINCT ON (s."workspaceId", s."userId", s."brandId")
       s."workspaceId", s."userId", s."brandId", s."id" AS "canonicalId"
FROM "copilot_session" s
ORDER BY s."workspaceId", s."userId", s."brandId", s."createdAt", s."id";

-- Every other session of a group, mapped to its canonical one.
CREATE TEMP TABLE pb_moved ON COMMIT DROP AS
SELECT s."id" AS "fromId", k."canonicalId"
FROM "copilot_session" s
JOIN pb_canonical k
  ON k."workspaceId" = s."workspaceId" AND k."userId" = s."userId"
 AND k."brandId" IS NOT DISTINCT FROM s."brandId"
WHERE s."id" <> k."canonicalId";

-- 3. MOVE THE TURNS OF EVERY OTHER SESSION INTO THE CANONICAL ONE --------------
--
-- Idempotency keys are unique per (workspace, session); keys from different
-- sessions could meet in the merged one, so a moved key is prefixed with the
-- session it came from, which keeps it unique by construction.

UPDATE "copilot_message" m
SET "sessionId" = v."canonicalId",
    "idempotencyKey" = CASE WHEN m."idempotencyKey" IS NULL THEN NULL
                            ELSE 'm:' || v."fromId" || ':' || m."idempotencyKey" END
FROM pb_moved v
WHERE m."sessionId" = v."fromId";

-- 4. COPY BRAND BRAIN MESSAGES INTO THE CANONICAL SESSION ---------------------
--
-- Same ids, so a second run finds them and inserts nothing. Bodies, purge
-- stamps, retention and accounting links are copied as they are. A key is
-- prefixed with its conversation for the reason in step 3.

INSERT INTO "copilot_message"
  ("id", "workspaceId", "sessionId", "role", "body", "bodyPurgedAt", "aiRequestId",
   "idempotencyKey", "correlationId", "expiresAt", "createdAt",
   "kind", "status", "citations", "insufficientKnowledge")
SELECT m."id", m."workspaceId", k."canonicalId",
       CASE WHEN upper(m."role") = 'USER' THEN 'USER'::"CopilotMessageRole"
            ELSE 'ASSISTANT'::"CopilotMessageRole" END,
       m."body", m."bodyPurgedAt", m."aiRequestId",
       CASE WHEN m."idempotencyKey" IS NULL THEN NULL
            ELSE 'bb:' || c."id" || ':' || m."idempotencyKey" END,
       gen_random_uuid(), m."expiresAt", m."createdAt",
       'message', 'complete', m."citations", m."insufficientKnowledge"
FROM "brand_brain_message" m
JOIN "brand_brain_conversation" c
  ON c."workspaceId" = m."workspaceId" AND c."id" = m."conversationId"
JOIN pb_canonical k
  ON k."workspaceId" = c."workspaceId" AND k."userId" = c."startedByUserId"
 AND k."brandId" IS NOT DISTINCT FROM c."brandId"
WHERE c."startedByUserId" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- 5. THE CANONICAL SESSION IS THE CONVERSATION; THE OTHERS ARE ARCHIVED --------
--
-- A continuous conversation does not expire as a whole (each message keeps its
-- own retention), so the canonical session is active with no session expiry.
-- The other sessions keep their plans and tool calls and are archived.

UPDATE "copilot_session" s
SET "archivedAt" = NULL, "expiresAt" = NULL,
    "lastMessageAt" = GREATEST(s."lastMessageAt", x."last"), "updatedAt" = now()
FROM pb_canonical k
LEFT JOIN (
  SELECT "workspaceId", "sessionId", max("createdAt") AS "last"
  FROM "copilot_message" GROUP BY "workspaceId", "sessionId"
) x ON x."workspaceId" = k."workspaceId" AND x."sessionId" = k."canonicalId"
WHERE s."id" = k."canonicalId"
  AND (s."archivedAt" IS NOT NULL OR s."expiresAt" IS NOT NULL
       OR s."lastMessageAt" IS DISTINCT FROM GREATEST(s."lastMessageAt", x."last"));

UPDATE "copilot_session" s
SET "archivedAt" = now(), "updatedAt" = now()
FROM pb_moved v
WHERE s."id" = v."fromId" AND s."archivedAt" IS NULL;

-- 6. ONE ACTIVE SESSION PER PERSON PER BRAND, FROM NOW ON ---------------------

CREATE UNIQUE INDEX IF NOT EXISTS "copilot_session_one_per_person_brand"
  ON "copilot_session" ("workspaceId", "userId", "brandId") NULLS NOT DISTINCT
  WHERE "archivedAt" IS NULL;

ALTER TABLE "copilot_session"          FORCE ROW LEVEL SECURITY;
ALTER TABLE "copilot_message"          FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_conversation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "brand_brain_message"      FORCE ROW LEVEL SECURITY;

COMMIT;
