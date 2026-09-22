-- ABUSE CEILINGS FOR THE AUTHENTICATION SURFACE — Phase 4, F-19.
--
-- F-19 has been open since Phase 2B: both realms lock an ACCOUNT after ten
-- failed attempts and neither throttles by SOURCE, so one attacker could spread
-- a few attempts each across thousands of accounts and never trip anything —
-- and could lock any named account at will. Signup and password reset had no
-- ceiling of any kind: a probe on unmodified main issued 25 password-reset
-- tokens for one address in a loop, which is 25 emails into somebody's inbox.
--
-- WHY POSTGRESQL AND NOT REDIS. R-07 named Redis for rate limits, and Redis is
-- where a per-request API throttle belongs. This counter is different: it is the
-- record of an attack in progress, it must survive a restart, and it must be
-- correct under concurrency rather than approximately correct. One statement —
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING — gives exactly-once counting
-- with the row lock PostgreSQL already takes, and it can be proven by a
-- deterministic race test against a real database rather than a timing one.
--
-- WHY THE TENANT ROLE CAN WRITE IT. Authentication precedes every workspace and
-- the CUSTOMER application performs it. The policy is the one `customer_session`
-- already carries: admitted only when no workspace context is set, so inside a
-- workspace the table is empty for the tenant role and one customer can neither
-- read nor grind another's counters.

CREATE TABLE "auth_rate_limit" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "scope"       TEXT         NOT NULL,
  "subjectHash" TEXT         NOT NULL,
  "windowStart" TIMESTAMPTZ(6) NOT NULL,
  "windowEnd"   TIMESTAMPTZ(6) NOT NULL,
  "count"       INTEGER      NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "auth_rate_limit_pkey" PRIMARY KEY ("id")
);

-- THE UNIQUE KEY IS THE CONCURRENCY CONTROL. Two simultaneous attempts collide
-- here, and ON CONFLICT DO UPDATE turns the loser into an increment of the
-- winner rather than a second row with a count of one.
CREATE UNIQUE INDEX "auth_rate_limit_scope_subjectHash_windowStart_key"
  ON "auth_rate_limit" ("scope", "subjectHash", "windowStart");

CREATE INDEX "auth_rate_limit_windowEnd_idx" ON "auth_rate_limit" ("windowEnd");

ALTER TABLE "auth_rate_limit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_rate_limit" FORCE ROW LEVEL SECURITY;

-- The authentication path, which runs with no workspace context.
CREATE POLICY tenant_isolation ON "auth_rate_limit"
  TO brandspace_app
  USING      (app.current_workspace_id() IS NULL)
  WITH CHECK (app.current_workspace_id() IS NULL);

CREATE POLICY platform_access ON "auth_rate_limit"
  TO brandspace_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_rate_limit" TO brandspace_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_rate_limit" TO brandspace_platform;
