-- F6 (docs/PROTOTYPE-V76-ALIGNMENT.md): `brandScope` IS NEVER NULL AGAIN.
--
-- `membership.brandScope` and `invitation.brandScope` were nullable, and NULL
-- and `{}` both meant "every brand in the workspace" to every reader in code
-- (`brandInScope`, `brandScopeFilter`, `brandIdScopeFilter`: `!scope ||
-- scope.length === 0`). A SQL array filter does not agree: `cardinality(NULL)
-- = 0` and `NULL @> ARRAY[x]` are NULL, not true, so `resolveRecipients` —
-- `isEmpty` OR `has` — silently skipped exactly the members with the widest
-- access, the owner onboarding writes without a scope.
--
-- THE MEANING OF NO STORED ROW CHANGES. NULL becomes `{}`, which every reader
-- already reads as unrestricted; a non-empty scope is not touched.
--
-- ONE TRANSACTION, D-112's discipline:
--   0. a 5-second lock timeout (below);
--   1. lift FORCE — the migrator owns both tables, is NOBYPASSRLS and has no
--      policy, so under FORCE it sees no row and the backfill would update
--      nothing; `ALTER TABLE` takes ACCESS EXCLUSIVE until COMMIT, so no other
--      session can observe the lifted state or insert between the backfill and
--      the constraint;
--   2. default `{}` — an insert that omits the column (an older release)
--      stores `{}` from here on;
--   3. backfill NULL → `{}`;
--   4. NOT NULL;
--   5. FORCE again, and 6. prove FORCE and NOT NULL, before COMMIT.
-- A failure anywhere rolls every step back, the lifted FORCE included.
--
-- FORWARD-ONLY (OPERATIONS §6): there is no down script. Dropping NOT NULL and
-- the default later would be harmless, and turning `{}` back into NULL is
-- neither possible (the two are indistinguishable now) nor useful.

BEGIN;

-- 0. NEVER QUEUE THE WHOLE PRODUCT BEHIND A LONG TRANSACTION (owner decision
-- D1). Every signed-in request reads `membership`; an ACCESS EXCLUSIVE request
-- waiting behind one long reader makes every request after it wait too. Five
-- seconds without the lock and this migration gives up, rolls back completely
-- (FORCE never lifted), and is retried — OPERATIONS §6.11 says how. The
-- application keeps working meanwhile: every reader treats NULL and `{}` alike.
SET LOCAL lock_timeout = '5s';

-- 1. LIFT FORCE, FOR THIS TRANSACTION ONLY.
ALTER TABLE "membership" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "invitation" NO FORCE ROW LEVEL SECURITY;

-- 2. THE DEFAULT (Prisma's `@default([])`).
ALTER TABLE "membership" ALTER COLUMN "brandScope" SET DEFAULT ARRAY[]::UUID[];
ALTER TABLE "invitation" ALTER COLUMN "brandScope" SET DEFAULT ARRAY[]::UUID[];

-- 3. BACKFILL. Only NULL rows are written; `updatedAt` is left alone, because
-- nobody changed anything a person would recognise.
UPDATE "membership" SET "brandScope" = ARRAY[]::UUID[] WHERE "brandScope" IS NULL;
UPDATE "invitation" SET "brandScope" = ARRAY[]::UUID[] WHERE "brandScope" IS NULL;

-- 4. NOT NULL.
ALTER TABLE "membership" ALTER COLUMN "brandScope" SET NOT NULL;
ALTER TABLE "invitation" ALTER COLUMN "brandScope" SET NOT NULL;

-- 5. RESTORE FORCE.
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
ALTER TABLE "invitation" FORCE ROW LEVEL SECURITY;

-- 6. PROVE IT: RLS enabled and forced on both, and the column NOT NULL.
DO $$
DECLARE
  problem text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO problem
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'brandScope'
   WHERE c.relname IN ('membership', 'invitation')
     AND c.relkind = 'r'
     AND c.relnamespace = 'public'::regnamespace
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity AND a.attnotnull);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'F6: RLS not forced or brandScope nullable on: %', problem;
  END IF;
  IF (SELECT count(*) FROM pg_class
       WHERE relname IN ('membership', 'invitation')
         AND relnamespace = 'public'::regnamespace AND relkind = 'r') <> 2 THEN
    RAISE EXCEPTION 'F6: expected exactly membership and invitation';
  END IF;
  -- No row-level NULL check here: with FORCE back on, the migrator sees no
  -- row, so it would prove nothing. `attnotnull` is the proof — SET NOT NULL
  -- scans every row, whatever RLS says, and refuses if one is NULL.
END
$$;

COMMIT;
