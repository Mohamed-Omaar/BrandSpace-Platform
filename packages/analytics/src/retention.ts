import type { PrismaClient } from '@brandspace/database';
import type { Clock } from '@brandspace/shared';
import type { AnalyticsPolicy } from './policy';

/**
 * RETENTION PRUNING — D-116 and D-117 applied to everything Phase 7 persists.
 *
 * THREE ARTEFACTS, THREE WINDOWS, ONE OWNER. Every feature that persists customer
 * content declares itself in the registry in `@brandspace/content`, names the
 * package responsible for deleting it, and points at the configuration path that
 * decides the window. This file is what that declaration promises.
 *
 * WHAT IS PRUNED AND WHAT IS NOT:
 *
 *   - `metric_observation`  — DELETED past the retention window. It is the raw
 *                             measurement and has no accounting role.
 *   - `analytics_ingestion_run` — DELETED past its own, much shorter window. It
 *                             is operations evidence, not customer data.
 *   - `insight` + evidence  — DELETED past the insight window, evidence by
 *                             cascade. An insight whose numbers can no longer be
 *                             checked is prose, and prose about performance that
 *                             nobody can verify is worse than nothing.
 * WHAT THIS FILE DELIBERATELY DOES NOT PRUNE: the Copilot's own artefacts. They
 * have a different owner (`@brandspace/copilot`), a different window and a
 * different treatment — a message body is NULLED rather than deleted — so they
 * live in `pruneCopilot`, next to the package the registry names as responsible.
 * Two owners, two functions, and neither claims the other's work.
 *
 * WHAT IS NEVER TOUCHED, whatever a window says: `audit_event`,
 * `credit_transaction`, `ai_usage_ledger`, `ai_request`. A retention control able
 * to erase a financial or a security record is a control that erases evidence,
 * which is precisely what a retention feature must not become
 * (`RETENTION_EXCLUDED_TABLES`).
 *
 * THE PLATFORM IDENTITY RUNS THESE. The enumeration is cross-tenant — "which
 * rows are past their window" is not a question any single tenant can ask — and
 * the tenant role has no DELETE on `analytics_ingestion_run` at all, by design.
 * Every pass is bounded and idempotent: a second pass finds nothing and does
 * nothing.
 */

export interface PruneResult {
  readonly observations: number;
  readonly runs: number;
  readonly insights: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export async function pruneAnalytics(input: {
  prisma: PrismaClient;
  policy: AnalyticsPolicy;
  clock: Clock;
  /** Rows removed per table per pass. Bounded so one pass cannot monopolise. */
  limit?: number;
}): Promise<PruneResult> {
  const now = input.clock.now();
  const batch = input.limit ?? input.policy.retention.pruneBatchSize;

  /*
   * A BOUNDED DELETE IS NOT `deleteMany` WITH A LIMIT — Prisma has no such
   * option, and an unbounded `deleteMany` over a year of a busy workspace is a
   * lock held for minutes. The id list is selected first, bounded, and then
   * deleted by primary key.
   */
  const observationCutoff = new Date(
    now.getTime() - input.policy.retention.maxRetentionDays * DAY_MS,
  );
  const staleObservations = await input.prisma.metricObservation.findMany({
    where: { periodStart: { lt: observationCutoff } },
    select: { id: true },
    take: batch,
  });
  const observations =
    staleObservations.length === 0
      ? 0
      : (
          await input.prisma.metricObservation.deleteMany({
            where: { id: { in: staleObservations.map((row) => row.id) } },
          })
        ).count;

  const runCutoff = new Date(now.getTime() - input.policy.retention.runRetentionDays * DAY_MS);
  const staleRuns = await input.prisma.analyticsIngestionRun.findMany({
    where: { startedAt: { lt: runCutoff } },
    select: { id: true },
    take: batch,
  });
  const runs =
    staleRuns.length === 0
      ? 0
      : (
          await input.prisma.analyticsIngestionRun.deleteMany({
            where: { id: { in: staleRuns.map((row) => row.id) } },
          })
        ).count;

  /*
   * INSIGHTS ARE PRUNED BY THEIR OWN `expiresAt`, which the generating service
   * resolved from the D-117 rules at creation time — NOT recomputed here. A purge
   * that re-derived the window would apply today's policy to content created
   * under yesterday's, which is how a retention promise quietly changes meaning.
   * The absolute ceiling is the second bound, for rows created before the column
   * existed.
   */
  const insightCeiling = new Date(
    now.getTime() - input.policy.retention.insightRetentionDays * DAY_MS,
  );
  const staleInsights = await input.prisma.insight.findMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { expiresAt: null, createdAt: { lt: insightCeiling } }],
    },
    select: { id: true },
    take: batch,
  });
  const insights =
    staleInsights.length === 0
      ? 0
      : (
          await input.prisma.insight.deleteMany({
            where: { id: { in: staleInsights.map((row) => row.id) } },
          })
        ).count;

  return { observations, runs, insights };
}
