-- Phase 6 final (D-277 §9-§10, D-295): what a person DECIDED about a
-- preference or a repeated workflow BrandSpace noticed in their own work.
--
-- The observations themselves are derived from the immutable audit trail and
-- are not copied here. This table holds only the decision, which cannot be
-- derived: accepted, "don't suggest again", or "not now" until a date.

CREATE TYPE "MemberSuggestionKind" AS ENUM ('PREFERENCE', 'WORKFLOW');
CREATE TYPE "MemberSuggestionStatus" AS ENUM ('ACCEPTED', 'DISMISSED', 'SNOOZED');

CREATE TABLE "member_suggestion" (
  "id"            UUID NOT NULL,
  "workspaceId"   UUID NOT NULL,
  "brandId"       UUID NOT NULL,
  "userId"        UUID NOT NULL,
  "kind"          "MemberSuggestionKind" NOT NULL,
  "key"           TEXT NOT NULL,
  "status"        "MemberSuggestionStatus" NOT NULL,
  "evidenceCount" INTEGER NOT NULL,
  "source"        TEXT NOT NULL,
  "decidedAt"     TIMESTAMPTZ(6) NOT NULL,
  "snoozedUntil"  TIMESTAMPTZ(6),
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "member_suggestion_pkey" PRIMARY KEY ("id")
);

-- "Not now" carries its date, and nothing else does.
ALTER TABLE "member_suggestion"
  ADD CONSTRAINT "member_suggestion_snoozed_consistently"
  CHECK (("status" = 'SNOOZED') = ("snoozedUntil" IS NOT NULL));

-- A workflow is never "accepted" here: accepting one hands it to the Copilot,
-- whose rule starts disabled (D-296). Only a preference becomes a default.
ALTER TABLE "member_suggestion"
  ADD CONSTRAINT "member_suggestion_only_preferences_accepted"
  CHECK ("status" <> 'ACCEPTED' OR "kind" = 'PREFERENCE');

-- Keys are the detector's closed forms; bounded so a key is never a sentence.
ALTER TABLE "member_suggestion"
  ADD CONSTRAINT "member_suggestion_key_shape"
  CHECK ("key" ~ '^[a-z0-9_.:-]{1,120}$' AND "evidenceCount" >= 0);

CREATE UNIQUE INDEX "member_suggestion_workspaceId_brandId_userId_kind_key_key"
  ON "member_suggestion" ("workspaceId", "brandId", "userId", "kind", "key");
CREATE INDEX "member_suggestion_workspaceId_userId_status_idx"
  ON "member_suggestion" ("workspaceId", "userId", "status");

-- COMPOSITE tenant references (D-99): the brand must be this workspace's.
ALTER TABLE "member_suggestion"
  ADD CONSTRAINT "member_suggestion_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_suggestion"
  ADD CONSTRAINT "member_suggestion_brand_fkey"
  FOREIGN KEY ("workspaceId", "brandId") REFERENCES "brand"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_suggestion"
  ADD CONSTRAINT "member_suggestion_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- row-level security ----------------------------------------------------

ALTER TABLE "member_suggestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member_suggestion" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "member_suggestion"
  TO brandspace_app
  USING      ("workspaceId" = app.current_workspace_id())
  WITH CHECK ("workspaceId" = app.current_workspace_id());

CREATE POLICY platform_access ON "member_suggestion"
  TO brandspace_platform USING (true) WITH CHECK (true);

-- --- grants ----------------------------------------------------------------
-- A decision is changed, never deleted, by the application: "don't suggest
-- again" is itself a decision worth keeping. The platform role keeps DELETE
-- for tenant offboarding.

GRANT SELECT, INSERT, UPDATE ON "member_suggestion" TO brandspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "member_suggestion" TO brandspace_platform;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'member_suggestion' AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'member_suggestion must have FORCE ROW LEVEL SECURITY';
  END IF;
END $$;
