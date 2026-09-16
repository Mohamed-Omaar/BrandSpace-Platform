import { createHash } from 'node:crypto';
import { Prisma, type TenantScopedClient } from '@brandspace/database';
import type {
  MetricGranularity,
  MetricSourceKind,
  MetricSubjectType,
  MetricUnit,
  SocialProvider,
} from '@brandspace/database';

/**
 * THE IDEMPOTENT WRITE PATH FOR METRIC OBSERVATIONS.
 *
 * ONE FILE, ONE STATEMENT, AND NO `findFirst` ANYWHERE IN IT.
 *
 * Every hazard this phase was asked to survive — two schedulers running at once,
 * a duplicate BullMQ delivery, a process dying after the provider answered, a
 * backfill overlapping a scheduled pull, a late redelivery of an older reading —
 * is the SAME hazard: two writers converging on one logical observation. A
 * "check then insert" loses every one of them, because the gap between the check
 * and the insert is precisely where the other writer is.
 *
 * So the write is a single `INSERT … ON CONFLICT DO UPDATE` against a UNIQUE
 * constraint, which is the database-safe primitive D-144 established for
 * publish-job materialisation. Concurrency correctness is a property of the
 * statement rather than of the code around it.
 *
 * `observationKey` IS THE IDENTITY OF THE MEASUREMENT, not of the request that
 * fetched it. Two different runs asking about the same day produce the same key,
 * which is exactly what makes re-asking a trailing window free — and re-asking a
 * trailing window is what lets a platform's revision of yesterday's figures
 * actually land.
 *
 * OUT-OF-ORDER DELIVERY IS HANDLED IN THE CONFLICT CLAUSE, not by the caller. A
 * redelivery carrying an OLDER `observedAt` than the stored row does not
 * overwrite it: the `WHERE` on the `DO UPDATE` refuses the move. Without it, a
 * retry that arrived after a fresher pull would silently roll a figure backwards
 * and no log line would say so.
 *
 * RLS STILL APPLIES. This runs on the tenant-scoped client inside
 * `withWorkspace`, so the policy constrains it exactly as it constrains Prisma's
 * own statements; the explicit `workspaceId` parameter is the tenant predicate
 * CLAUDE.md §5 requires of raw SQL, and the `WITH CHECK` refuses a row for any
 * other workspace even if this file were wrong.
 */

export interface ObservationInput {
  readonly workspaceId: string;
  readonly brandId: string;
  readonly socialConnectionId: string;
  readonly provider: SocialProvider;
  readonly subjectType: MetricSubjectType;
  readonly subjectExternalId: string;
  readonly publishJobId: string | null;
  readonly contentItemId: string | null;
  readonly metricKey: string;
  readonly granularity: MetricGranularity;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly value: bigint;
  readonly unit: MetricUnit;
  readonly observedAt: Date;
  readonly sourceKind: MetricSourceKind;
  readonly sourceVersion: string;
  readonly ingestionRunId: string | null;
}

/**
 * The deterministic identity of one logical observation.
 *
 * WHAT IS IN IT AND WHY EACH PART IS THERE:
 *   - workspace and connection: the account the figure belongs to.
 *   - subject type and id: the post or the account measured.
 *   - metric key: which figure.
 *   - granularity and period start: the window. A day and a week beginning on
 *     the same instant are DIFFERENT observations, which is why granularity is
 *     in the key and why `periodEnd` is not — it is implied by the pair.
 *
 * WHAT IS DELIBERATELY NOT IN IT: the run, the adapter version, the value, and
 * anything about WHEN we asked. All of those change between two fetches of the
 * same measurement, and a key that included them would make every re-fetch a new
 * row — which is to say, would make the idempotency ornamental.
 */
export function observationKeyFor(input: {
  workspaceId: string;
  socialConnectionId: string;
  subjectType: MetricSubjectType;
  subjectExternalId: string;
  metricKey: string;
  granularity: MetricGranularity;
  periodStart: Date;
}): string {
  return createHash('sha256')
    .update(
      [
        input.workspaceId,
        input.socialConnectionId,
        input.subjectType,
        input.subjectExternalId,
        input.metricKey,
        input.granularity,
        input.periodStart.toISOString(),
      ].join('|'),
    )
    .digest('hex');
}

export interface UpsertResult {
  /** Rows the statement actually inserted or updated. */
  readonly written: number;
  /**
   * Rows that were already present and at least as fresh, so nothing moved.
   * Arithmetic, exactly as D-144's `existing` is: the count we sent minus the
   * count PostgreSQL reported changing.
   */
  readonly unchanged: number;
}

/**
 * Write a batch of observations idempotently.
 *
 * ONE STATEMENT FOR THE WHOLE BATCH rather than one per reading. A pull of
 * twenty-five posts across ten metrics is two hundred and fifty readings, and
 * two hundred and fifty round trips inside one transaction is how an ingestion
 * pass starts timing out under load.
 */
export async function upsertObservations(
  db: TenantScopedClient,
  workspaceId: string,
  observations: readonly ObservationInput[],
): Promise<UpsertResult> {
  if (observations.length === 0) return { written: 0, unchanged: 0 };

  /*
   * EVERY ROW IS CHECKED AGAINST THE CALLER'S WORKSPACE BEFORE IT IS SENT.
   *
   * RLS would refuse a foreign row anyway — the `WITH CHECK` on
   * `tenant_isolation` sees to that — but a refusal at the database is an
   * exception in the middle of a batch, and the caller would have no way to say
   * which reading caused it. This turns a confusing failure into an impossible
   * one, and it is the tenant predicate CLAUDE.md §5 asks raw SQL to carry.
   */
  for (const observation of observations) {
    if (observation.workspaceId !== workspaceId) {
      throw new Error('An observation batch may not mix workspaces.');
    }
  }

  const values = observations.map((o) => {
    const key = observationKeyFor(o);
    return Prisma.sql`(
      gen_random_uuid(),
      ${o.workspaceId}::uuid,
      ${o.brandId}::uuid,
      ${o.socialConnectionId}::uuid,
      ${o.provider}::"SocialProvider",
      ${o.subjectType}::"MetricSubjectType",
      ${o.subjectExternalId},
      ${o.publishJobId}::uuid,
      ${o.contentItemId}::uuid,
      ${o.metricKey},
      ${o.granularity}::"MetricGranularity",
      ${o.periodStart}::timestamptz,
      ${o.periodEnd}::timestamptz,
      ${o.value}::bigint,
      ${o.unit}::"MetricUnit",
      ${o.observedAt}::timestamptz,
      now(),
      ${o.sourceKind}::"MetricSourceKind",
      ${o.sourceVersion},
      ${o.ingestionRunId}::uuid,
      ${key}
    )`;
  });

  /*
   * THE `WHERE` ON THE `DO UPDATE` IS THE OUT-OF-ORDER GUARD.
   *
   * A redelivery carrying a reading the provider observed EARLIER than the one
   * already stored is not an update; it is stale news. Accepting it would roll a
   * figure backwards, and the customer would see a chart change for no reason
   * anybody could later explain. `>=` rather than `>` so a re-fetch of the same
   * observation still refreshes its provenance and its run link.
   */
  const written = await db.$executeRaw`
    INSERT INTO "metric_observation" (
      "id", "workspaceId", "brandId", "socialConnectionId", "provider",
      "subjectType", "subjectExternalId", "publishJobId", "contentItemId",
      "metricKey", "granularity", "periodStart", "periodEnd",
      "value", "unit", "observedAt", "ingestedAt",
      "sourceKind", "sourceVersion", "ingestionRunId", "observationKey"
    )
    VALUES ${Prisma.join(values, ',')}
    ON CONFLICT ("workspaceId", "observationKey") DO UPDATE SET
      "value"          = EXCLUDED."value",
      "unit"           = EXCLUDED."unit",
      "periodEnd"      = EXCLUDED."periodEnd",
      "observedAt"     = EXCLUDED."observedAt",
      "ingestedAt"     = EXCLUDED."ingestedAt",
      "publishJobId"   = COALESCE(EXCLUDED."publishJobId", "metric_observation"."publishJobId"),
      "contentItemId"  = COALESCE(EXCLUDED."contentItemId", "metric_observation"."contentItemId"),
      "sourceKind"     = EXCLUDED."sourceKind",
      "sourceVersion"  = EXCLUDED."sourceVersion",
      "ingestionRunId" = EXCLUDED."ingestionRunId"
    WHERE EXCLUDED."observedAt" >= "metric_observation"."observedAt"
  `;

  return { written, unchanged: Math.max(0, observations.length - written) };
}
