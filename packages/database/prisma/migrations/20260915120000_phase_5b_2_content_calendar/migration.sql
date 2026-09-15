-- ---------------------------------------------------------------------------
-- Phase 5B-2 — Content Calendar (docs/PRODUCT.md §5 module 6,
-- docs/DATABASE.md §4.7 and §4.7b, docs/ROADMAP.md Phase 5 scope item 5's
-- planning half).
--
-- ONE TENANT-OWNED TABLE. `calendar_slot` records WHEN a content item goes out;
-- `content_item` remains the source of truth for what it is and what state it
-- is in. A second copy of a caption, a status or a channel list here would be a
-- second answer to a question `content_item` already answers, and the two would
-- drift the first time one was updated without the other.
--
-- BOTH FOREIGN KEYS TO A TENANT-OWNED PARENT ARE COMPOSITE (D-112).
-- `calendar_slot.contentItemId` is exactly the shape F-80 and F-83 were about —
-- a child pointing at a tenant-owned parent by id alone. PostgreSQL evaluates
-- referential integrity as the table OWNER with RLS bypassed, so a plain key
-- would resolve another workspace's draft perfectly well and accept the row,
-- and the difference between "inserted" and "constraint violated" would answer
-- "does this id exist?" across the tenant boundary.
--
-- THIS MIGRATION IS PURELY ADDITIVE. It creates one enum, one table, its
-- indexes, its policies and its grants, and admits nothing else. No existing
-- row changes and no existing behaviour changes.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The slot's own short lifecycle.
--
-- DELIBERATELY SHORTER THAN docs/DATABASE.md §4.7's DESIGN. `LOCKED`,
-- `PUBLISHING`, `PUBLISHED` and `FAILED` belong to the publishing pipeline, and
-- the pipeline is Phase 6. A state no code can enter is a state whose meaning
-- nobody has settled — the same reason `content_item` has no `campaignId`.
-- ---------------------------------------------------------------------------

CREATE TYPE "CalendarSlotStatus" AS ENUM ('PLANNED', 'SCHEDULED', 'CANCELLED');

-- ---------------------------------------------------------------------------
-- 2. The table.
--
-- THREE TIME COLUMNS, NOT ONE (AC-14.2, AC-14.3). A timestamp alone cannot
-- answer "what time did the customer MEAN?" across a daylight-saving boundary:
-- 09:00 local converted to UTC in January and read back in July is 08:00 or
-- 10:00, and neither is what anyone asked for. So the INTENT
-- (`scheduledLocalTime` + `timezone`) is stored beside the INSTANT
-- (`scheduledAtUtc`), and the instant is recomputed from the intent when the
-- zone's offset changes.
--
-- `scheduledLocalTime` is TEXT and not a timestamp, deliberately: it is a local
-- wall-clock with no offset, and giving it one would invent the very fact the
-- column exists to preserve.
--
-- `timezone` is COPIED from the workspace rather than joined, because a
-- workspace that relocates must not silently move every post it has already
-- scheduled.
-- ---------------------------------------------------------------------------

CREATE TABLE "calendar_slot" (
    "id"                  UUID NOT NULL,
    "workspaceId"         UUID NOT NULL,
    "brandId"             UUID NOT NULL,
    "contentItemId"       UUID NOT NULL,

    "scheduledAtUtc"      TIMESTAMPTZ(6) NOT NULL,
    "scheduledLocalTime"  TEXT NOT NULL,
    "timezone"            TEXT NOT NULL,

    "status"              "CalendarSlotStatus" NOT NULL DEFAULT 'PLANNED',

    -- AC-14.7 — the publishing target is a MOCK, and the data says so rather
    -- than only a comment. Phase 6 adds real connection targets beside it;
    -- until then nothing in this system can name one.
    "targetKind"          TEXT NOT NULL DEFAULT 'MOCK',

    "platformKeys"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    "createdByUserId"     UUID,
    "cancelledAt"         TIMESTAMPTZ(6),

    -- The quota event this slot consumed (AC-14.5), so cancelling refunds
    -- exactly what scheduling took and a retry cannot double-count.
    "usageIdempotencyKey" TEXT,

    "createdAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"           TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "calendar_slot_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 3. A local wall-clock is a SHAPE, and the database checks it.
--
-- `scheduledLocalTime` is free text as far as PostgreSQL is concerned, and a
-- column the service is the only guard for is a column that eventually holds
-- whatever a future call site passes. `YYYY-MM-DDTHH:mm` is the whole contract;
-- anything else — an offset, a seconds field, a locale-formatted date — would
-- silently break the recomputation the column exists for.
-- ---------------------------------------------------------------------------

ALTER TABLE "calendar_slot"
  ADD CONSTRAINT "calendar_slot_local_time_shape"
  CHECK ("scheduledLocalTime" ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$');

-- A cancelled slot has a cancellation time, and a live one does not. Without
-- this the two facts can disagree, and every reader then has to decide which
-- one it trusts.
ALTER TABLE "calendar_slot"
  ADD CONSTRAINT "calendar_slot_cancelled_consistently"
  CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 4. Foreign keys. BOTH COMPOSITE (D-112).
--
-- `calendar_slot_item_fkey` on `(workspaceId, contentItemId)` is the one F-80
-- and F-83 were about. The pair must exist, so another tenant's draft id is
-- refused identically to an invented one — same SQLSTATE, same constraint name,
-- no oracle.
--
-- ON DELETE CASCADE on both: a deleted brand or a hard-deleted content item
-- takes its plan with it. There is nothing to preserve in a slot whose content
-- no longer exists, and a dangling plan would render as a post nobody can open.
-- ---------------------------------------------------------------------------

ALTER TABLE "calendar_slot"
  ADD CONSTRAINT "calendar_slot_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "calendar_slot"
  ADD CONSTRAINT "calendar_slot_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "calendar_slot"
  ADD CONSTRAINT "calendar_slot_item_fkey"
  FOREIGN KEY ("workspaceId", "contentItemId") REFERENCES "content_item"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 5. Indexes.
--
-- The calendar's only query shape is a RANGE over a month or a week, optionally
-- narrowed to one brand, so both range indexes lead with the tenant and end
-- with the instant. `(status, scheduledAtUtc)` serves the due-slot sweep Phase 6
-- will add, and is cheap now.
-- ---------------------------------------------------------------------------

CREATE INDEX "calendar_slot_workspaceId_scheduledAtUtc_idx"
  ON "calendar_slot" ("workspaceId", "scheduledAtUtc");
CREATE INDEX "calendar_slot_workspaceId_brandId_scheduledAtUtc_idx"
  ON "calendar_slot" ("workspaceId", "brandId", "scheduledAtUtc");
CREATE INDEX "calendar_slot_workspaceId_contentItemId_idx"
  ON "calendar_slot" ("workspaceId", "contentItemId");
CREATE INDEX "calendar_slot_status_scheduledAtUtc_idx"
  ON "calendar_slot" ("status", "scheduledAtUtc");

-- ---------------------------------------------------------------------------
-- 6. ONE LIVE SLOT PER CONTENT ITEM — a PARTIAL unique index.
--
-- Two live slots for the same draft is a calendar that shows the same post
-- twice and a quota charged twice, and the service refusing it is not the same
-- as the database refusing it: the service can be bypassed by the next call
-- site, a background job or a raw statement.
--
-- PARTIAL, on `status <> 'CANCELLED'`, and that is the whole point. A full
-- unique index would mean a draft taken off the calendar could never be put
-- back — the cancelled row would hold its slot for ever. The same shape D-100
-- settled for the asset checksum, and it lives here rather than in
-- `schema.prisma` because Prisma cannot model a WHERE clause on a unique index.
-- `prisma migrate diff` does not model it either, so it produces no drift.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "calendar_slot_one_live_per_item"
  ON "calendar_slot" ("workspaceId", "contentItemId")
  WHERE "status" <> 'CANCELLED';

-- ---------------------------------------------------------------------------
-- 7. Row-Level Security. ENABLED and FORCED, like every tenant-owned table.
--
-- FORCE matters as much as ENABLE: without it the policy does not apply to the
-- table's OWNER, and a migration or a maintenance statement running as owner
-- would see every tenant at once (D-113).
-- ---------------------------------------------------------------------------

ALTER TABLE "calendar_slot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_slot" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "calendar_slot"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "calendar_slot"
  TO brandspace_platform USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 8. Privileges — least privilege, as everywhere else.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON "calendar_slot" TO brandspace_app, brandspace_platform;

COMMIT;
