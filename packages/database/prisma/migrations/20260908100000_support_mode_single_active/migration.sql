-- A-10. ONE LIVE SUPPORT SESSION PER (WORKSPACE, OPERATOR).
--
-- `SupportModeService.start` ended any existing session and then created a new
-- one, in two separate statements, and its comment claimed "one active session
-- per (actor, workspace)". Nothing enforced it. Two concurrent starts both ran
-- the UPDATE (finding nothing to end), both ran the INSERT, and the workspace
-- ended up with two overlapping grants — which is precisely the state the
-- comment says the design exists to avoid, because accesses made under two
-- live grants cannot be attributed to either.
--
-- A partial unique index makes the overlap impossible at the level where
-- concurrency actually happens. The service also takes a row lock so the
-- ordinary path never has to see a violation; this is the backstop that holds
-- even if a future caller forgets.
--
-- Existing overlaps are closed first, oldest kept open, so the index can be
-- created on live data. Nothing is deleted: an ended session is still a
-- complete audit record of the access it covered.
UPDATE "support_mode_session" s
   SET "endedAt" = now()
 WHERE s."endedAt" IS NULL
   AND EXISTS (
     SELECT 1
       FROM "support_mode_session" other
      WHERE other."workspaceId" = s."workspaceId"
        AND other."platformUserId" = s."platformUserId"
        AND other."endedAt" IS NULL
        AND (other."grantedAt" > s."grantedAt"
             OR (other."grantedAt" = s."grantedAt" AND other."id" > s."id"))
   );

CREATE UNIQUE INDEX "support_mode_session_one_active_idx"
    ON "support_mode_session" ("workspaceId", "platformUserId")
 WHERE "endedAt" IS NULL;
