-- D-112 across Phase 3 and Phase 4 — the five keys F-80 did not reach.
--
-- D-112 made the composite workspace-scoped foreign key a PLATFORM-WIDE rule,
-- but it was written while fixing Brand Brain (F-80/F-83) and applied there.
-- The cross-phase audit found five relationships in earlier phases that still
-- referenced a tenant-owned parent by id alone:
--
--   credit_transaction."walletId"      -> credit_wallet(id)
--   credit_grant."walletId"            -> credit_wallet(id)
--   credit_reservation."walletId"      -> credit_wallet(id)
--   ai_usage_ledger."aiRequestId"      -> ai_request(id)
--   ai_usage_ledger."correctsLedgerId" -> ai_usage_ledger(id)
--
-- THESE WERE NOT THEORETICAL. Two were demonstrated before this migration was
-- written: from inside workspace A, a row naming workspace B's wallet and a row
-- naming workspace B's ai_request were both ACCEPTED. PostgreSQL evaluates
-- referential integrity as the table owner with RLS bypassed, so the plain key
-- resolved the other tenant's row, and the difference between "inserted" and
-- "violates foreign key" answered *does that id exist?* — the write-side form
-- of the inference CLAUDE.md §2.1 forbids.
--
-- The credit keys are the worse pair: they attach a MONEY LEDGER row to another
-- tenant's wallet. The application never does this — it resolves the wallet
-- from the workspace in `#lockWallet` and never accepts a wallet id from input
-- — which is exactly why this survived so long. §2.1 requires two independent
-- layers, and the second one was open.
--
-- THE SELF-REFERENCE is the sharpest of the five, for the reason F-80 recorded
-- about its own: `correctsLedgerId` asks "is this ledger id real?" and answers.

-- ---------------------------------------------------------------------------
-- 0. ONE TRANSACTION, EXPLICITLY.
--
-- PRISMA DOES NOT WRAP A MIGRATION FILE IN A TRANSACTION — it applies the
-- statements one at a time. Atomicity therefore has to be ASKED FOR, and this
-- migration genuinely needs it: §1 lifts a protection that §5 restores, and
-- those two must be inseparable.
--
-- WITHOUT THIS, the §2 pre-flight's own RAISE would be a tenant-isolation
-- REGRESSION rather than a safe refusal: the `NO FORCE` statements would have
-- committed individually, so six tables would be left readable by their owner
-- outside RLS, and no later migration could repair it — a later migration only
-- runs if this one is marked resolved, and by then the window has been open for
-- as long as the operator took to notice. `20260914200000` §0 records the same
-- rule (D-113); this migration was written without it and is corrected here
-- before merge, which is why there is no follow-up migration to do it.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. RLS. Every table touched below is ENABLE + FORCE, so the migrator — which
--    OWNS them — is still subject to their policies. A pre-flight anti-join run
--    under FORCE would see ZERO rows and report a clean database no matter what
--    it held, and `ADD CONSTRAINT` would then validate against rows it could
--    not see. The same reasoning, and the same remedy, as `20260914200000`.
--
--    ENABLE is not touched, no policy is touched, no GRANT is issued. §5
--    asserts FORCE is back rather than assuming it.
-- ---------------------------------------------------------------------------

ALTER TABLE "credit_wallet"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "credit_transaction" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "credit_grant"       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "credit_reservation" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ai_request"         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage_ledger"    NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. PRE-FLIGHT. FAIL, DO NOT REPAIR.
--
-- A RAISE aborts the transaction and leaves the database exactly as it was.
-- The message carries the relationship and a COUNT and never an id, a workspace
-- or any row content: a migration log is not a place customer data belongs.
-- Refusing here also means the operator sees counts rather than PostgreSQL's
-- own DETAIL line, which prints the offending key.
--
-- The nullable `correctsLedgerId` is filtered rather than joined blindly:
-- MATCH SIMPLE satisfies a composite key whenever any referencing column is
-- NULL, so a ledger row that corrects nothing is exempt BY CONSTRUCTION and
-- counting it would refuse a migration over rows the constraint accepts.
-- ---------------------------------------------------------------------------

DO $$
DECLARE offending BIGINT;
BEGIN
  SELECT count(*) INTO offending
    FROM "credit_transaction" c
    LEFT JOIN "credit_wallet" w
      ON w."id" = c."walletId" AND w."workspaceId" = c."workspaceId"
   WHERE w."id" IS NULL;
  IF offending > 0 THEN
    RAISE EXCEPTION
      'credit_transaction.walletId: % row(s) reference a wallet in another workspace or no wallet at all', offending;
  END IF;

  SELECT count(*) INTO offending
    FROM "credit_grant" g
    LEFT JOIN "credit_wallet" w
      ON w."id" = g."walletId" AND w."workspaceId" = g."workspaceId"
   WHERE w."id" IS NULL;
  IF offending > 0 THEN
    RAISE EXCEPTION
      'credit_grant.walletId: % row(s) reference a wallet in another workspace or no wallet at all', offending;
  END IF;

  SELECT count(*) INTO offending
    FROM "credit_reservation" r
    LEFT JOIN "credit_wallet" w
      ON w."id" = r."walletId" AND w."workspaceId" = r."workspaceId"
   WHERE w."id" IS NULL;
  IF offending > 0 THEN
    RAISE EXCEPTION
      'credit_reservation.walletId: % row(s) reference a wallet in another workspace or no wallet at all', offending;
  END IF;

  SELECT count(*) INTO offending
    FROM "ai_usage_ledger" l
    LEFT JOIN "ai_request" q
      ON q."id" = l."aiRequestId" AND q."workspaceId" = l."workspaceId"
   WHERE q."id" IS NULL;
  IF offending > 0 THEN
    RAISE EXCEPTION
      'ai_usage_ledger.aiRequestId: % row(s) reference a request in another workspace or no request at all', offending;
  END IF;

  SELECT count(*) INTO offending
    FROM "ai_usage_ledger" l
    LEFT JOIN "ai_usage_ledger" p
      ON p."id" = l."correctsLedgerId" AND p."workspaceId" = l."workspaceId"
   WHERE l."correctsLedgerId" IS NOT NULL AND p."id" IS NULL;
  IF offending > 0 THEN
    RAISE EXCEPTION
      'ai_usage_ledger.correctsLedgerId: % row(s) correct a ledger entry in another workspace or no entry at all', offending;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. THE REFERENCED UNIQUES. `id` is already the primary key, so (workspaceId,
--    id) is unique by construction — these exist to give the foreign keys
--    something to reference, which PostgreSQL requires, not to constrain
--    anything new. Created as UNIQUE INDEXes to match what `prisma migrate
--    diff` emits for `@@unique([workspaceId, id])`, so a migrations-only
--    database and the schema stay byte-identical.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "credit_wallet_workspaceId_id_key"
  ON "credit_wallet"("workspaceId", "id");

CREATE UNIQUE INDEX "ai_request_workspaceId_id_key"
  ON "ai_request"("workspaceId", "id");

CREATE UNIQUE INDEX "ai_usage_ledger_workspaceId_id_key"
  ON "ai_usage_ledger"("workspaceId", "id");

-- ---------------------------------------------------------------------------
-- 4. REPLACE EACH PLAIN KEY WITH ITS WORKSPACE-SCOPED COMPOSITE.
--
-- Each ADD CONSTRAINT validates every existing row — for real, because §1 made
-- them visible — so these are a second, independent check on top of §2.
--
-- ON UPDATE NO ACTION throughout: a workspaceId is never rewritten, and a key
-- that silently followed one would be a cross-tenant move rather than an
-- update. The delete actions are preserved exactly as they were.
-- ---------------------------------------------------------------------------

ALTER TABLE "credit_transaction"
  DROP CONSTRAINT "credit_transaction_walletId_fkey";
ALTER TABLE "credit_transaction"
  ADD CONSTRAINT "credit_transaction_wallet_fkey"
  FOREIGN KEY ("workspaceId", "walletId")
  REFERENCES "credit_wallet"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "credit_grant"
  DROP CONSTRAINT "credit_grant_walletId_fkey";
ALTER TABLE "credit_grant"
  ADD CONSTRAINT "credit_grant_wallet_fkey"
  FOREIGN KEY ("workspaceId", "walletId")
  REFERENCES "credit_wallet"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "credit_reservation"
  DROP CONSTRAINT "credit_reservation_walletId_fkey";
ALTER TABLE "credit_reservation"
  ADD CONSTRAINT "credit_reservation_wallet_fkey"
  FOREIGN KEY ("workspaceId", "walletId")
  REFERENCES "credit_wallet"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "ai_usage_ledger"
  DROP CONSTRAINT "ai_usage_ledger_aiRequestId_fkey";
ALTER TABLE "ai_usage_ledger"
  ADD CONSTRAINT "ai_usage_ledger_request_fkey"
  FOREIGN KEY ("workspaceId", "aiRequestId")
  REFERENCES "ai_request"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "ai_usage_ledger"
  DROP CONSTRAINT "ai_usage_ledger_correctsLedgerId_fkey";
ALTER TABLE "ai_usage_ledger"
  ADD CONSTRAINT "ai_usage_ledger_corrects_fkey"
  FOREIGN KEY ("workspaceId", "correctsLedgerId")
  REFERENCES "ai_usage_ledger"("workspaceId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 5. RESTORE FORCE, AND ASSERT IT. A migration that left any of these tables
--    readable by its owner outside RLS would be a tenant-isolation regression
--    introduced by a tenant-isolation fix.
-- ---------------------------------------------------------------------------

ALTER TABLE "credit_wallet"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "credit_transaction" FORCE ROW LEVEL SECURITY;
ALTER TABLE "credit_grant"       FORCE ROW LEVEL SECURITY;
ALTER TABLE "credit_reservation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ai_request"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage_ledger"    FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['credit_wallet','credit_transaction','credit_grant',
                           'credit_reservation','ai_request','ai_usage_ledger'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
       WHERE oid = format('%I', t)::regclass
         AND relrowsecurity IS TRUE
         AND relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION '% must have RLS ENABLED and FORCED after this migration', t;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 6. COMMIT. Everything above succeeded together, or none of it happened and
--    FORCE was never lifted as far as any other session could observe.
-- ---------------------------------------------------------------------------

COMMIT;
