-- A BOUNDED SWEEP THAT EVENTUALLY REACHES EVERY CONNECTION (D-229).
--
-- The Phase 2 cursor wiring enumerated ACTIVE connections with `analyticsCursors:
-- { none: {} }` — connections with NO cursor at all. That repairs exactly one
-- state, "never provisioned", and nothing else. A connection holding a PARTIAL
-- cursor set matched the filter no longer and was therefore skipped FOR EVER:
--
--   * an adapter gains `supportsPostMetrics`, so POST cursors are now required;
--   * an adapter's `supportedGranularities` grows a value;
--   * one insert of an earlier set failed, or was rolled back;
--   * a cursor row was removed by an operator or a tenant purge.
--
-- In each case the connection had at least one cursor, so the repair pass that
-- exists to fix it could not see it. `ensureIngestionCursors` was already built
-- to insert the COMPLETE required set idempotently; only the enumeration was
-- too narrow.
--
-- WHY A COLUMN RATHER THAN DROPPING THE FILTER. Simply asking for every ACTIVE
-- connection re-introduces the starvation D-182 names: past `take: batch` a
-- stable ordering returns the same head of the queue on every tick and the tail
-- is never visited. D-182 answered that with a durable cursor the sweep parks
-- into, and this is the same answer for the same reason.
--
-- NULLABLE, AND NOT BACKFILLED. NULL means "this sweep has never ensured this
-- connection", and `ORDER BY ... ASC NULLS FIRST` — the ordering R4-2 already
-- established for `analytics_ingestion_cursor."nextAttemptAt"` — puts exactly
-- those first. So every connection that exists today is at the front of the
-- queue on the next tick, which is the behaviour a repair pass should have.
-- Backfilling `now()` would say the opposite: that they had all just been
-- checked.
--
-- IT NEVER TOUCHES INGESTION STATE. This column records when the sweep last ran
-- its insert, and nothing else. Cursor progress, retry backoff and freshness
-- live on `analytics_ingestion_cursor` and are written only by ingestion; the
-- ensure statement remains ON CONFLICT DO NOTHING, so a cursor that already
-- exists is left exactly as it is.

ALTER TABLE "social_connection"
  ADD COLUMN "analyticsCursorsEnsuredAt" TIMESTAMPTZ(6);

-- The sweep's own query: ACTIVE connections, least-recently-ensured first. The
-- index carries the ordering so the bounded enumeration stays a LIMIT over an
-- index rather than a sort over the table.
CREATE INDEX "social_connection_status_analyticsCursorsEnsuredAt_idx"
  ON "social_connection" ("status", "analyticsCursorsEnsuredAt");
