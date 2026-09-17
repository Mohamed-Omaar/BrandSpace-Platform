import type { MetricUnit } from '@brandspace/database';

/**
 * THE CANONICAL METRIC VOCABULARY — the single set of names this platform
 * reasons in, and the boundary every provider is translated across.
 *
 * WHY THIS IS CODE AND NOT CONFIGURATION, when almost nothing else in this
 * platform is. A metric KEY is the name application code asks for, exactly as an
 * AI task key is (`packages/ai-gateway/src/tasks.ts`) and a permission key is:
 * the anomaly detector asks for `engagement_rate`, the chart renders
 * `impressions`, and renaming one is a code change rather than an operator
 * action. Its UNIT is intrinsic in the same way — a rate is a rate whatever an
 * operator would prefer. What IS configuration is everything an operator
 * legitimately tunes: ingestion cadence, freshness windows, anomaly thresholds,
 * retention. None of it appears in this file.
 *
 * MISSING AND ZERO ARE DIFFERENT STATES, AND THIS TABLE IS WHERE THAT STARTS.
 * `supportedBy` is the declared list of providers that actually report a metric.
 * A provider absent from it does not return 0 for that metric — it returns
 * NOTHING, and the product says "this platform does not publish this figure"
 * rather than drawing a zero that reads as "you earned none". Phase 6 made the
 * same distinction for publishing capabilities (docs/SOCIAL-INTEGRATIONS.md
 * §1.7): capabilities are declared, never assumed equal.
 *
 * NOTHING HERE IS INVENTED. Every key below is a figure the named platforms
 * publish through their own analytics APIs. A metric no provider reports has no
 * entry, because an entry would be a promise the ingestion cannot keep.
 */

import type { SocialProvider } from '@brandspace/database';

/** Whether a metric is a level (a stock) or a movement (a flow). */
export type MetricKind = 'volume' | 'rate' | 'duration' | 'movement';

export interface MetricDefinition {
  /** The canonical key. Stable, lowercase, snake_case. */
  readonly key: string;
  readonly unit: MetricUnit;
  readonly kind: MetricKind;
  /**
   * Whether summing this metric across subjects or windows is MATHEMATICALLY
   * VALID.
   *
   * This flag is the reason totals in this product can be trusted. Impressions
   * add up; an engagement RATE does not, and "average of the daily rates" is not
   * the rate over the period either. A UI that summed a rate would print a
   * number that is simply false, and it would look entirely plausible. Rates are
   * therefore never summed — they are RECOMPUTED from their components, which is
   * what `derivedFrom` is for.
   */
  readonly additive: boolean;
  /**
   * HOW THIS METRIC IS COMBINED — stated, not inferred (P7-R7).
   *
   *   `SUM`                   a FLOW. Impressions in a window are the sum of the
   *                           impressions in its buckets, across every account.
   *   `LATEST_PER_SUBJECT_SUM` a STOCK, or level. "Followers over March" is not a
   *                           sum over March and it is not the largest reading in
   *                           March either — it is each account's MOST RECENT
   *                           reading in March, added up across accounts.
   *   `DERIVED`               recomputed from components; never aggregated at all.
   *
   * WHY THE FLAG EXISTS WHEN `additive` ALREADY DID. `additive` answers "may I
   * sum this?", and the answer for a level is "no" — which left every call site
   * to invent what to do instead. All three invented the same thing, `MAX(value)`,
   * and `MAX` is not `latest`: an account that LOSES followers reports its
   * highest reading in the window for ever, and the number only ever goes up.
   * Naming the semantics is what stops a fourth call site inventing a fifth
   * answer.
   */
  readonly aggregation: 'SUM' | 'LATEST_PER_SUBJECT_SUM' | 'DERIVED';
  /**
   * For a derived metric: the numerator and denominator it is computed from.
   * A derived metric is NEVER ingested; it is computed at query time from
   * observations a provider actually returned, so it cannot exist without them.
   */
  readonly derivedFrom?: { readonly numerator: string; readonly denominator: string };
  /**
   * Which providers publish this figure. A provider not listed here has NO
   * observation for the metric, and the product says so instead of showing zero.
   */
  readonly supportedBy: readonly SocialProvider[];
  /** The i18n key stem. Copy lives in the message catalogue, never here. */
  readonly messageKey: string;
}

const ALL: readonly SocialProvider[] = ['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'LINKEDIN', 'X'];

/**
 * The INGESTED metrics: figures a provider returns, stored verbatim after unit
 * normalization and nothing else.
 */
export const INGESTED_METRICS: readonly MetricDefinition[] = [
  {
    key: 'impressions',
    unit: 'COUNT',
    kind: 'volume',
    additive: true,
    aggregation: 'SUM',
    supportedBy: ALL,
    messageKey: 'impressions',
  },
  {
    key: 'reach',
    unit: 'COUNT',
    kind: 'volume',
    additive: true,
    aggregation: 'SUM',
    // X publishes impressions but not de-duplicated reach on the public
    // analytics surface, so it is absent rather than mapped onto impressions —
    // which would be inventing a metric the provider did not return.
    supportedBy: ['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'LINKEDIN'],
    messageKey: 'reach',
  },
  {
    key: 'engagements',
    unit: 'COUNT',
    kind: 'volume',
    additive: true,
    aggregation: 'SUM',
    supportedBy: ALL,
    messageKey: 'engagements',
  },
  {
    key: 'likes',
    unit: 'COUNT',
    kind: 'volume',
    additive: true,
    aggregation: 'SUM',
    supportedBy: ALL,
    messageKey: 'likes',
  },
  {
    key: 'comments',
    unit: 'COUNT',
    kind: 'volume',
    additive: true,
    aggregation: 'SUM',
    supportedBy: ALL,
    messageKey: 'comments',
  },
  {
    key: 'shares',
    unit: 'COUNT',
    kind: 'volume',
    additive: true,
    aggregation: 'SUM',
    supportedBy: ALL,
    messageKey: 'shares',
  },
  {
    key: 'saves',
    unit: 'COUNT',
    kind: 'volume',
    additive: true,
    aggregation: 'SUM',
    // Saves are an Instagram, Facebook and TikTok concept. LinkedIn and X do not
    // publish one, so neither has a row — not a zero.
    supportedBy: ['FACEBOOK', 'INSTAGRAM', 'TIKTOK'],
    messageKey: 'saves',
  },
  {
    key: 'clicks',
    unit: 'COUNT',
    kind: 'volume',
    additive: true,
    aggregation: 'SUM',
    supportedBy: ['FACEBOOK', 'LINKEDIN', 'X'],
    messageKey: 'clicks',
  },
  {
    key: 'video_views',
    unit: 'COUNT',
    kind: 'volume',
    additive: true,
    aggregation: 'SUM',
    supportedBy: ['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'X'],
    messageKey: 'videoViews',
  },
  {
    key: 'watch_time_seconds',
    unit: 'SECONDS',
    kind: 'duration',
    additive: true,
    aggregation: 'SUM',
    supportedBy: ['TIKTOK', 'FACEBOOK'],
    messageKey: 'watchTime',
  },
  {
    key: 'followers',
    unit: 'COUNT',
    kind: 'volume',
    // A follower COUNT is a level, not a flow. Summing a level across days
    // produces a number with no meaning at all, which is why this is the one
    // volume metric that is not additive.
    additive: false,
    // THE ONE LEVEL METRIC. Each account's latest reading in the window, summed
    // across the brand's accounts.
    aggregation: 'LATEST_PER_SUBJECT_SUM',
    supportedBy: ALL,
    messageKey: 'followers',
  },
  {
    key: 'follower_change',
    unit: 'DELTA',
    kind: 'movement',
    // A movement DOES add up: net change over a week is the sum of the daily
    // net changes. It is signed, which is why its unit is DELTA.
    additive: true,
    aggregation: 'SUM',
    supportedBy: ['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'LINKEDIN'],
    messageKey: 'followerChange',
  },
];

/**
 * The DERIVED metrics: never ingested, always recomputed from observations.
 *
 * A derived metric with a missing component is MISSING, not zero. If a provider
 * returned engagements but no impressions, there is no engagement rate to show —
 * and `computeDerived` returns null rather than dividing by a zero it invented.
 */
export const DERIVED_METRICS: readonly MetricDefinition[] = [
  {
    key: 'engagement_rate',
    unit: 'RATIO_MILLI',
    kind: 'rate',
    additive: false,
    aggregation: 'DERIVED',
    derivedFrom: { numerator: 'engagements', denominator: 'impressions' },
    supportedBy: ALL,
    messageKey: 'engagementRate',
  },
  {
    key: 'click_through_rate',
    unit: 'RATIO_MILLI',
    kind: 'rate',
    additive: false,
    aggregation: 'DERIVED',
    derivedFrom: { numerator: 'clicks', denominator: 'impressions' },
    supportedBy: ['FACEBOOK', 'LINKEDIN', 'X'],
    messageKey: 'clickThroughRate',
  },
  {
    key: 'save_rate',
    unit: 'RATIO_MILLI',
    kind: 'rate',
    additive: false,
    aggregation: 'DERIVED',
    derivedFrom: { numerator: 'saves', denominator: 'reach' },
    supportedBy: ['FACEBOOK', 'INSTAGRAM', 'TIKTOK'],
    messageKey: 'saveRate',
  },
];

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  ...INGESTED_METRICS,
  ...DERIVED_METRICS,
];

const BY_KEY = new Map<string, MetricDefinition>(METRIC_DEFINITIONS.map((m) => [m.key, m]));

export const METRIC_KEYS: readonly string[] = METRIC_DEFINITIONS.map((m) => m.key);
export const INGESTED_METRIC_KEYS: readonly string[] = INGESTED_METRICS.map((m) => m.key);

export function findMetric(key: string): MetricDefinition | undefined {
  return BY_KEY.get(key);
}

export function isMetricKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** Is this metric one a provider returns, rather than one we compute? */
export function isIngestedMetric(key: string): boolean {
  return INGESTED_METRICS.some((m) => m.key === key);
}

/**
 * Does this provider publish this metric at all?
 *
 * THE ANSWER THE UI NEEDS BEFORE IT DRAWS ANYTHING. "No row, and the platform
 * does not publish it" and "no row, and we have not fetched yet" are different
 * sentences to a customer, and only this function can tell them apart.
 */
export function providerSupportsMetric(provider: SocialProvider, key: string): boolean {
  const definition = BY_KEY.get(key);
  return definition !== undefined && definition.supportedBy.includes(provider);
}

/** Every metric the given provider publishes, in catalogue order. */
export function metricsForProvider(provider: SocialProvider): readonly MetricDefinition[] {
  return METRIC_DEFINITIONS.filter((m) => m.supportedBy.includes(provider));
}

/**
 * Compute a derived metric, or return null when it cannot be computed.
 *
 * NULL IS THE IMPORTANT RETURN. A rate whose denominator is missing does not
 * exist; a rate whose denominator is zero does not exist either — dividing by it
 * would either throw or, far worse, be quietly coerced into 0 and rendered as
 * "0% engagement", which is a claim about performance rather than about data.
 */
export function computeDerived(
  key: string,
  components: Readonly<Record<string, bigint | undefined>>,
): bigint | null {
  const definition = BY_KEY.get(key);
  if (!definition?.derivedFrom) return null;

  const numerator = components[definition.derivedFrom.numerator];
  const denominator = components[definition.derivedFrom.denominator];
  if (numerator === undefined || denominator === undefined) return null;
  if (denominator <= 0n) return null;

  // Parts per mille, integer division. Rounded half-up so 4.55% does not become
  // 4.5% on one screen and 4.6% on another.
  return (numerator * 2000n + denominator) / (denominator * 2n);
}

/**
 * May these values be summed?
 *
 * Called by every aggregate path, so "totals where mathematically valid" is a
 * property the code enforces rather than a sentence in a document.
 */
export function isAdditive(key: string): boolean {
  return BY_KEY.get(key)?.additive === true;
}

/**
 * The declared combination rule for a metric.
 *
 * An unknown key is `SUM` — the caller has already refused an unknown metric by
 * the time this is reached, and a default that matched the common case is less
 * surprising than one that matched nothing.
 */
export function aggregationFor(key: string): 'SUM' | 'LATEST_PER_SUBJECT_SUM' | 'DERIVED' {
  return BY_KEY.get(key)?.aggregation ?? 'SUM';
}

/** Does this metric measure a LEVEL, whose window value is its latest reading? */
export function isLevelMetric(key: string): boolean {
  return aggregationFor(key) === 'LATEST_PER_SUBJECT_SUM';
}
