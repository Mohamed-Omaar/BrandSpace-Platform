import {
  parseConfigPayload,
  type ConfigurationService,
  type Environment,
} from '@brandspace/config';
import type { AnalyticsFreshness } from '@brandspace/database';
import type { Clock } from '@brandspace/shared';

/**
 * Where the analytics policy comes from, and who may ask for it.
 *
 * NOTHING IN THIS FILE IS A POLICY VALUE. The schema in
 * `packages/config/src/domains.ts` is the single place a default lives, and this
 * is the plumbing that carries an activated document to the surfaces that run on
 * it — exactly the shape `TenantPublishingPolicySource` and
 * `TenantContentPolicySource` already have.
 *
 * TWO ENTRY POINTS, THE SAME PARSE:
 *   - `resolveAnalyticsPolicy` needs a ConfigurationService and therefore the
 *     PLATFORM identity. Only `apps/api` and `apps/admin` may hold that (F-07).
 *   - Everything tenant-side reads `TenantAnalyticsPolicySource` — the
 *     projection in `entitlement_catalogue_snapshot`, which the tenant role may
 *     read and may not write.
 */

export const ANALYTICS_CONFIG_DOMAIN = 'analytics';

export interface AnalyticsPolicy {
  readonly ingestion: {
    readonly dailyIntervalMinutes: number;
    readonly hourlyIntervalMinutes: number;
    readonly refreshWindowDays: number;
    readonly subjectsPerRequest: number;
    readonly claimBatchSize: number;
    readonly claimLeaseSeconds: number;
    readonly publishingReserveMilli: number;
  };
  readonly backfill: {
    readonly enabled: boolean;
    readonly maxDays: number;
    readonly daysPerPass: number;
  };
  readonly freshness: {
    readonly freshWithinMinutes: number;
    readonly staleAfterMinutes: number;
  };
  readonly retry: {
    readonly maxConsecutiveFailures: number;
    readonly initialBackoffSeconds: number;
    readonly backoffMultiplier: number;
    readonly maxBackoffSeconds: number;
    readonly jitterRatio: number;
  };
  readonly anomaly: {
    readonly deviationThresholdMilli: number;
    readonly baselinePeriods: number;
    readonly minimumBaselineValue: number;
  };
  readonly explain: {
    readonly maxEvidenceItems: number;
    readonly minEvidenceItems: number;
    readonly maxWindowDays: number;
  };
  readonly export: {
    readonly maxWindowDays: number;
    readonly maxRows: number;
  };
  readonly retention: {
    readonly maxRetentionDays: number;
    readonly runRetentionDays: number;
    readonly insightRetentionDays: number;
    readonly pruneBatchSize: number;
  };
}

export function parseAnalyticsPolicy(payload: unknown): AnalyticsPolicy {
  return parseConfigPayload(ANALYTICS_CONFIG_DOMAIN, payload) as AnalyticsPolicy;
}

/** Read the active `analytics` document. Platform surfaces only. */
export async function resolveAnalyticsPolicy(
  configuration: Pick<ConfigurationService, 'get'>,
  environment: Environment,
): Promise<AnalyticsPolicy> {
  return parseAnalyticsPolicy(await configuration.get(ANALYTICS_CONFIG_DOMAIN, environment));
}

/**
 * The slice of the tenant-scoped client this source needs. Structural rather
 * than the full `PrismaClient`, so a caller can hand it the scoped client it
 * already holds inside a workspace transaction.
 */
export interface AnalyticsCatalogueReader {
  readonly entitlementCatalogueSnapshot: {
    findUnique(args: {
      where: { domain_environment: { domain: string; environment: Environment } };
    }): Promise<{ payload: unknown } | null>;
  };
}

export class TenantAnalyticsPolicySource {
  readonly #db: AnalyticsCatalogueReader;
  readonly #environment: Environment;

  constructor(db: AnalyticsCatalogueReader, environment: Environment) {
    this.#db = db;
    this.#environment = environment;
  }

  async load(): Promise<AnalyticsPolicy> {
    const row = await this.#db.entitlementCatalogueSnapshot.findUnique({
      where: {
        domain_environment: {
          domain: ANALYTICS_CONFIG_DOMAIN,
          environment: this.#environment,
        },
      },
    });
    // A workspace whose operator has not activated the domain yet gets the
    // schema's own defaults — which are valid, bounded and written down in one
    // place, rather than a set of constants scattered through call sites.
    return parseAnalyticsPolicy(row?.payload ?? {});
  }
}

/**
 * HOW CURRENT IS THIS, given when it last succeeded?
 *
 * ONE FUNCTION, CALLED EVERYWHERE, so the badge on a chart, the state stored on
 * the cursor and the sentence in an export header cannot disagree. The Brand
 * Brain scope helper exists for the same reason: a rule implemented three times
 * gets three answers.
 *
 * NEVER-SUCCEEDED IS `UNAVAILABLE`, NOT `STALE`. They are different sentences to
 * a customer — "we have not managed to read this yet" and "this is old" — and
 * collapsing them would make a brand new connection look neglected.
 */
export function freshnessFor(
  policy: AnalyticsPolicy,
  lastSucceededAt: Date | null | undefined,
  clock: Clock,
): AnalyticsFreshness {
  if (!lastSucceededAt) return 'UNAVAILABLE';
  const ageMinutes = (clock.now().getTime() - lastSucceededAt.getTime()) / 60_000;
  if (ageMinutes <= policy.freshness.freshWithinMinutes) return 'FRESH';
  if (ageMinutes <= policy.freshness.staleAfterMinutes) return 'AGING';
  return 'STALE';
}

/**
 * The next attempt time after `failures` consecutive failures.
 *
 * BOUNDED, AND JITTERED. Unbounded backoff is how a connection stops being
 * retried at all; un-jittered backoff is how every workspace that failed during
 * one platform outage comes back at the same instant and causes the next one.
 *
 * `random` is injected rather than read from `Math` so a test asserts a schedule
 * instead of a range.
 */
export function nextAttemptAfterFailure(
  policy: AnalyticsPolicy,
  failures: number,
  clock: Clock,
  random: () => number,
): Date {
  const exponent = Math.max(0, failures - 1);
  const raw = policy.retry.initialBackoffSeconds * policy.retry.backoffMultiplier ** exponent;
  const capped = Math.min(raw, policy.retry.maxBackoffSeconds);
  const jitter = capped * policy.retry.jitterRatio * (random() * 2 - 1);
  const seconds = Math.max(1, Math.round(capped + jitter));
  return new Date(clock.now().getTime() + seconds * 1_000);
}
