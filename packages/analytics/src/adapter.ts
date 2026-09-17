import type {
  MetricGranularity,
  MetricSubjectType,
  MetricUnit,
  PublishFailureClass,
  SocialProvider,
} from '@brandspace/database';

/**
 * THE ANALYTICS CONNECTOR CONTRACT — the one boundary every external metrics API
 * is reached through.
 *
 * DELIBERATELY SEPARATE FROM `SocialConnectorAdapter`, which publishes. They
 * answer different questions, fail differently, and — the part that matters —
 * carry different authority: a publishing adapter can change the world, and an
 * analytics adapter can only read it. Keeping them apart means nothing on the
 * ingestion path can reach `publish()`, by construction rather than by care.
 *
 * WHAT THIS INTERFACE DELIBERATELY DOES NOT HAVE, for the reasons its publishing
 * sibling does not have them:
 *
 *   - No database. An adapter is given what it needs and returns what it found.
 *   - No credential RESOLUTION. `AdapterCredentials` arrives already decrypted by
 *     the one code path allowed to do that, and the adapter must not log it,
 *     attach it to a span, or put it in an error.
 *   - No retry, and no backoff. Both are decisions about a workspace's schedule
 *     and a provider's shared budget, which an adapter cannot see. It classifies;
 *     the ingestion service decides.
 *   - No clock. The adapter reports what the provider said it observed; the
 *     caller stamps when WE heard it, with the clock it was injected with.
 *
 * CAPABILITIES ARE DECLARED, NOT ASSUMED EQUAL. `supportedMetrics` is what makes
 * "this platform does not publish that figure" a thing the product can SAY,
 * rather than a zero it draws. An adapter that returned a metric outside its own
 * declaration is refused by `normalizeReadings` — the declaration is a contract
 * in both directions.
 */

/** Already-decrypted OAuth material. Never logged, never serialized. */
export interface AdapterCredentials {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

export interface AnalyticsCapabilities {
  readonly enabled: boolean;
  /** Canonical metric keys this provider publishes. */
  readonly supportedMetrics: readonly string[];
  /** Windows it will answer for. Asking for one outside this is refused here. */
  readonly supportedGranularities: readonly MetricGranularity[];
  /** Whether per-post figures are available at all, or only account totals. */
  readonly supportsPostMetrics: boolean;
  /** How far back the provider will answer. Bounds every backfill. */
  readonly maxBackfillDays: number;
  /**
   * The provider's own request budget, as the ingestion service understands it.
   * SHARED WITH PUBLISHING through `ProviderRateLimiter`, so analytics cannot
   * spend the budget a scheduled post needs.
   */
  readonly requestsPerWindow: number;
  readonly rateLimitWindowSeconds: number;
}

/** One metric, as the provider reported it, already mapped to a canonical key. */
export interface MetricReading {
  readonly subjectType: MetricSubjectType;
  /** The provider's own id for the measured thing. */
  readonly subjectExternalId: string;
  readonly metricKey: string;
  readonly value: bigint;
  readonly unit: MetricUnit;
  readonly granularity: MetricGranularity;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** WHEN THE PROVIDER SAYS IT OBSERVED THIS — not when we asked. */
  readonly observedAt: Date;
}

export interface FetchSuccess {
  readonly ok: true;
  /**
   * Only metrics the provider ACTUALLY RETURNED. A metric it does not publish,
   * and a metric it publishes but had no data for, are both ABSENT — there is no
   * way to express "zero" other than by returning a reading whose value is zero,
   * which is what a provider reporting a genuine zero produces.
   */
  readonly readings: readonly MetricReading[];
  /** Subjects asked about, and subjects the provider actually answered for. */
  readonly subjectsRequested: number;
  readonly subjectsAnswered: number;
  /**
   * True when the provider answered for SOME subjects and refused others — a
   * first-class outcome, because discarding the part that worked would make a
   * partial outage look like a total one.
   */
  readonly partial: boolean;
}

export interface FetchFailure {
  readonly ok: false;
  readonly failureClass: PublishFailureClass;
  /** A stable machine code for the UI. NEVER the provider's own message. */
  readonly failureCode: string;
  /** Short, redacted, bounded. Safe to store and to show support. */
  readonly safeSummary: string;
  /** Honoured for `RATE_LIMITED`, where the provider says when to come back. */
  readonly retryAfterSeconds?: number;
}

export type FetchOutcome = FetchSuccess | FetchFailure;

export interface FetchRequest {
  /** The provider's account id this connection points at. */
  readonly externalAccountId: string;
  readonly subjectType: MetricSubjectType;
  /** For POST metrics: the external post ids to ask about. */
  readonly subjectExternalIds: readonly string[];
  readonly granularity: MetricGranularity;
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

export interface AnalyticsConnectorAdapter {
  readonly provider: SocialProvider;
  readonly capabilities: AnalyticsCapabilities;
  /**
   * The adapter's own contract version, stored on every observation it produces.
   * A normalization change bumps it, so a figure recorded under an older mapping
   * is identifiable rather than silently rewritten.
   */
  readonly sourceVersion: string;
  /** PROVIDER or MOCK. Stored on every row, so a chart can say what it rests on. */
  readonly sourceKind: 'PROVIDER' | 'MOCK';

  fetch(input: {
    readonly request: FetchRequest;
    readonly credentials: AdapterCredentials;
  }): Promise<FetchOutcome>;

  /** Turn whatever went wrong into a class the ingestion service can act on. */
  classifyError(error: unknown): PublishFailureClass;
}
