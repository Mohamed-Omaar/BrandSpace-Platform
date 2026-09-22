import { createHash } from 'node:crypto';
import type {
  MetricGranularity,
  MetricSubjectType,
  PublishFailureClass,
  SocialProvider,
} from '@brandspace/database';
import type {
  AnalyticsCapabilities,
  AnalyticsConnectorAdapter,
  FetchOutcome,
  FetchRequest,
  MetricReading,
} from './adapter';
import { assertNotProduction } from '@brandspace/shared';
import { findMetric, metricsForProvider } from './metrics';

/**
 * DETERMINISTIC MOCK METRIC SOURCES.
 *
 * WHY THESE EXIST. Every platform in this product requires business
 * verification and app review before it issues a production analytics
 * credential — the same multi-week, owner-driven process that keeps the
 * publishing connectors mocked (D-18, D-19). Phase 6 chose honesty over a
 * pretend integration, and this phase makes the same choice for the same reason:
 * shipping an adapter that has never been run against a real API would be
 * claiming an integration that does not exist.
 *
 * WHAT THEY ARE NOT. Not stubs that return a plausible number. They model the
 * things the ingestion's correctness actually rests on — a provider that
 * publishes some metrics and not others, a rate limit with a retry-after, an
 * expired token, a partial answer, a window the provider will not go back
 * beyond, and a late reading that arrives out of order.
 *
 * DETERMINISTIC BY CONSTRUCTION. Every value is a pure function of (provider,
 * subject, metric, period). The same request produces the same number on every
 * run, on every machine, for ever: there is no clock, no randomness and no
 * shared state, because a flaky analytics test would be indistinguishable from
 * the ingestion bug it is meant to catch.
 *
 * PRODUCTION NEVER GETS THESE. `createAnalyticsRegistry` refuses to hand back a
 * mock in a PRODUCTION environment — a deployment with no real source must not
 * come up looking healthy and draw charts out of arithmetic.
 */

/**
 * Behaviour markers, read out of the ACCOUNT ID rather than configured.
 *
 * A marker rather than a switch, for the reason the publishing mocks use one:
 * one test can exercise success and rate-limiting in the same run without
 * mutating anything a parallel test can see.
 */
const BEHAVIOUR_MARKERS = {
  'analytics-rate-limit': 'RATE_LIMITED',
  'analytics-auth-expired': 'AUTH_EXPIRED',
  'analytics-auth-revoked': 'AUTH_REVOKED',
  'analytics-down': 'PLATFORM_UNAVAILABLE',
  'analytics-timeout': 'TIMEOUT',
  'analytics-gone': 'TARGET_UNAVAILABLE',
} as const satisfies Record<string, PublishFailureClass>;

/** An account id carrying this marker answers for only half its subjects. */
const PARTIAL_MARKER = 'analytics-partial';
/** An account id carrying this marker returns NOTHING — an empty, valid answer. */
const EMPTY_MARKER = 'analytics-empty';

function behaviourFor(externalAccountId: string): PublishFailureClass | null {
  for (const [marker, failureClass] of Object.entries(BEHAVIOUR_MARKERS)) {
    if (externalAccountId.includes(marker)) return failureClass as PublishFailureClass;
  }
  return null;
}

const SAFE_SUMMARIES: Partial<Record<PublishFailureClass, string>> = {
  RATE_LIMITED: 'The platform is rate limiting analytics requests for this account.',
  AUTH_EXPIRED: 'The access token has expired.',
  AUTH_REVOKED: 'Authorization was revoked at the platform.',
  PLATFORM_UNAVAILABLE: 'The platform analytics API is temporarily unavailable.',
  TIMEOUT: 'The platform did not answer in time.',
  TARGET_UNAVAILABLE: 'The account is no longer reachable.',
};

/**
 * A stable pseudo-value in [0, span) derived from its inputs.
 *
 * Hash-based rather than seeded-random, so no ordering, no shared generator and
 * no test-execution order can change what comes back.
 */
function stableValue(span: number, ...parts: string[]): number {
  const digest = createHash('sha256').update(parts.join('|')).digest();
  // Four bytes is plenty and stays inside a safe integer.
  const raw = digest.readUInt32BE(0);
  return raw % span;
}

const DEFAULT_CAPABILITIES: Record<
  SocialProvider,
  Omit<AnalyticsCapabilities, 'supportedMetrics'>
> = {
  FACEBOOK: {
    enabled: true,
    supportedGranularities: ['DAY', 'WEEK', 'MONTH', 'LIFETIME'],
    supportsPostMetrics: true,
    maxBackfillDays: 93,
    requestsPerWindow: 200,
    rateLimitWindowSeconds: 3_600,
  },
  INSTAGRAM: {
    enabled: true,
    supportedGranularities: ['DAY', 'WEEK', 'MONTH', 'LIFETIME'],
    supportsPostMetrics: true,
    maxBackfillDays: 93,
    requestsPerWindow: 200,
    rateLimitWindowSeconds: 3_600,
  },
  TIKTOK: {
    enabled: true,
    supportedGranularities: ['DAY', 'WEEK', 'LIFETIME'],
    supportsPostMetrics: true,
    maxBackfillDays: 60,
    requestsPerWindow: 100,
    rateLimitWindowSeconds: 3_600,
  },
  LINKEDIN: {
    enabled: true,
    supportedGranularities: ['DAY', 'WEEK', 'MONTH'],
    supportsPostMetrics: true,
    maxBackfillDays: 365,
    requestsPerWindow: 100,
    rateLimitWindowSeconds: 86_400,
  },
  X: {
    enabled: true,
    // X publishes no weekly or monthly rollup on the surface this product
    // would use, so asking for one is refused here rather than answered with a
    // number assembled out of daily rows the provider never rolled up itself.
    supportedGranularities: ['DAY', 'LIFETIME'],
    supportsPostMetrics: true,
    maxBackfillDays: 28,
    requestsPerWindow: 50,
    rateLimitWindowSeconds: 900,
  },
};

/**
 * Which metrics a MOCK answers for at ACCOUNT level versus POST level.
 *
 * Not every metric exists at both levels on a real platform, and pretending
 * otherwise is exactly the kind of small dishonesty that makes a mock useless as
 * a contract test. A follower count is an account fact; a save is a post fact.
 */
const ACCOUNT_ONLY = new Set(['followers', 'follower_change']);
const POST_ONLY = new Set(['saves', 'video_views', 'watch_time_seconds']);

export class MockAnalyticsConnectorAdapter implements AnalyticsConnectorAdapter {
  readonly provider: SocialProvider;
  readonly capabilities: AnalyticsCapabilities;
  readonly sourceVersion = 'mock-1';
  readonly sourceKind = 'MOCK' as const;

  constructor(provider: SocialProvider) {
    /*
     * ITS OWN GUARD, NOT SOMEBODY ELSE'S — Phase 4, reconciling the Phase 1 note.
     *
     * The factory/registry refusal that used to be the only thing keeping this
     * out of production is correct and is still there. It is not sufficient on
     * its own: it protects the ONE path that goes through it, and a `new` at any
     * other call site — a script, a test helper promoted to a service, a new
     * caller written by somebody who did not know the rule — reaches this
     * constructor directly. CLAUDE.md §2.2 names `assertNotProduction()` as the
     * way a double joins the refusing set; this is that call.
     */
    assertNotProduction(
      'A mock analytics connector',
      'Configure a real analytics connector in Platform Admin > Integrations before deploying to production.',
    );
    this.provider = provider;
    const base = DEFAULT_CAPABILITIES[provider];
    this.capabilities = {
      ...base,
      // DECLARED FROM THE CATALOGUE, not restated. `metricsForProvider` already
      // knows which platform publishes which figure; a second list here would be
      // a second answer to one question.
      supportedMetrics: metricsForProvider(provider)
        .filter((m) => m.derivedFrom === undefined)
        .map((m) => m.key),
    };
  }

  async fetch(input: {
    request: FetchRequest;
    credentials: { accessToken: string; refreshToken: string | null };
  }): Promise<FetchOutcome> {
    const { request } = input;

    const failure = behaviourFor(request.externalAccountId);
    if (failure) {
      return {
        ok: false,
        failureClass: failure,
        failureCode: `mock_${failure.toLowerCase()}`,
        safeSummary: SAFE_SUMMARIES[failure] ?? 'The platform returned an unexpected response.',
        ...(failure === 'RATE_LIMITED' ? { retryAfterSeconds: 120 } : {}),
      };
    }

    /*
     * A GRANULARITY THE PROVIDER DOES NOT PUBLISH IS REFUSED BEFORE ANY DATA IS
     * MADE UP. The alternative — rolling daily rows into a "week" the provider
     * never rolled up — would be the product inventing a figure and attributing
     * it to a platform.
     */
    if (!this.capabilities.supportedGranularities.includes(request.granularity)) {
      return {
        ok: false,
        failureClass: 'UNSUPPORTED',
        failureCode: 'granularity_not_published',
        safeSummary: 'This platform does not publish figures for that period length.',
      };
    }
    if (request.subjectType === 'POST' && !this.capabilities.supportsPostMetrics) {
      return {
        ok: false,
        failureClass: 'UNSUPPORTED',
        failureCode: 'post_metrics_not_published',
        safeSummary: 'This platform does not publish per-post figures.',
      };
    }

    const subjects =
      request.subjectType === 'ACCOUNT'
        ? [request.externalAccountId]
        : [...request.subjectExternalIds];

    if (request.externalAccountId.includes(EMPTY_MARKER)) {
      // A VALID, EMPTY ANSWER. The provider is reachable and has nothing to say
      // about this window — which is not a failure, and not a zero either.
      return {
        ok: true,
        readings: [],
        subjectsRequested: subjects.length,
        subjectsAnswered: subjects.length,
        partial: false,
      };
    }

    const partial = request.externalAccountId.includes(PARTIAL_MARKER) && subjects.length > 1;
    const answered = partial ? subjects.slice(0, Math.ceil(subjects.length / 2)) : subjects;

    const readings: MetricReading[] = [];
    for (const subject of answered) {
      for (const metricKey of this.capabilities.supportedMetrics) {
        if (request.subjectType === 'ACCOUNT' && POST_ONLY.has(metricKey)) continue;
        if (request.subjectType === 'POST' && ACCOUNT_ONLY.has(metricKey)) continue;

        const definition = findMetric(metricKey);
        /* c8 ignore next -- supportedMetrics is built from the catalogue. */
        if (!definition) continue;

        const reading = this.#reading({
          subjectType: request.subjectType,
          subject,
          metricKey,
          granularity: request.granularity,
          periodStart: request.windowStart,
          periodEnd: request.windowEnd,
        });
        if (reading) readings.push(reading);
      }
    }

    return {
      ok: true,
      readings,
      subjectsRequested: subjects.length,
      subjectsAnswered: answered.length,
      partial,
    };
  }

  #reading(input: {
    subjectType: MetricSubjectType;
    subject: string;
    metricKey: string;
    granularity: MetricGranularity;
    periodStart: Date;
    periodEnd: Date;
  }): MetricReading | null {
    const definition = findMetric(input.metricKey);
    /* c8 ignore next -- callers pass a catalogue key. */
    if (!definition) return null;

    const seed = [
      this.provider,
      input.subjectType,
      input.subject,
      input.metricKey,
      input.periodStart.toISOString(),
    ];

    /*
     * SOME SUBJECTS GENUINELY HAVE NO ROW FOR SOME METRICS, and the mock models
     * that rather than filling every cell. A post with no link has no clicks;
     * the provider omits the metric entirely and the product must cope with a
     * hole rather than with a zero. One subject in eight is silent on each
     * optional metric, chosen deterministically.
     */
    const OPTIONAL = new Set(['clicks', 'saves', 'watch_time_seconds', 'follower_change']);
    if (OPTIONAL.has(input.metricKey) && stableValue(8, ...seed, 'presence') === 0) return null;

    let value: bigint;
    switch (input.metricKey) {
      case 'impressions':
        value = BigInt(400 + stableValue(9_600, ...seed));
        break;
      case 'reach':
        value = BigInt(300 + stableValue(6_000, ...seed));
        break;
      case 'followers':
        value = BigInt(1_000 + stableValue(50_000, this.provider, input.subject, 'followers'));
        break;
      case 'follower_change':
        // Signed: a real account loses followers on real days.
        value = BigInt(stableValue(120, ...seed)) - 40n;
        break;
      case 'watch_time_seconds':
        value = BigInt(60 + stableValue(20_000, ...seed));
        break;
      default:
        value = BigInt(stableValue(400, ...seed));
        break;
    }

    return {
      subjectType: input.subjectType,
      subjectExternalId: input.subject,
      metricKey: input.metricKey,
      value,
      unit: definition.unit,
      granularity: input.granularity,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      /*
       * THE PROVIDER'S OWN OBSERVATION STAMP, and deliberately not "now".
       *
       * A real platform answers today with a reading it took at the end of the
       * window, and freshness that conflated the two would call stale data
       * current. Derived from the window rather than from a clock, so the mock
       * has no clock at all — the lint rule that forbids `new Date()` in this
       * codebase is pointing at exactly this hazard.
       */
      observedAt: input.periodEnd,
    };
  }

  classifyError(error: unknown): PublishFailureClass {
    if (error instanceof Error && error.name === 'AbortError') return 'TIMEOUT';
    return 'UNKNOWN';
  }
}
