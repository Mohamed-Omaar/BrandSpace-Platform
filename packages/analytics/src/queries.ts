import type { Prisma } from '@brandspace/database';
import type {
  AnalyticsFreshness,
  MetricGranularity,
  MetricSubjectType,
  MetricUnit,
  SocialProvider,
  TenantScopedClient,
} from '@brandspace/database';
import {
  assertBrandInScope,
  brandIdQueryFilter,
  systemClock,
  type Clock,
} from '@brandspace/shared';
import {
  computeDerived,
  DERIVED_METRICS,
  findMetric,
  isAdditive,
  isLevelMetric,
  providerSupportsMetric,
} from './metrics';
import { freshnessFor, type AnalyticsPolicy } from './policy';
import { countPublishedPosts } from './published';
import type { AnalyticsRegistry } from './registry';

/**
 * READING ANALYTICS — brand, campaign, platform and post.
 *
 * THREE RULES THIS FILE EXISTS TO KEEP, and each one has a failure mode that
 * looks fine on screen:
 *
 *  1. BRANDSCOPE IS A QUERY PREDICATE, NEVER A POST-READ FILTER (D-132/D-134).
 *     Every aggregate below passes `brandIdQueryFilter` into the `where`, so a
 *     member restricted to one brand never has another brand's rows summed and
 *     then removed. A post-read filter over an AGGREGATE is worse than useless:
 *     the number was already computed from rows the caller may not see, and
 *     filtering afterwards cannot un-compute it. This is the single most likely
 *     way a cross-brand leak would enter an analytics feature, and it enters
 *     through a `SUM` rather than through a list.
 *
 *  2. TOTALS ONLY WHERE SUMMING IS VALID. `isAdditive` gates every sum.
 *     Impressions add up; an engagement RATE does not, and the average of daily
 *     rates is not the rate over the period either. A rate is RECOMPUTED from its
 *     components — which is also why a rate whose components are missing is
 *     missing rather than zero.
 *
 *  3. MISSING IS NOT ZERO, ANYWHERE. A metric with no rows returns `null`, and
 *     the caller is told WHY: the platform does not publish it, nothing has been
 *     published yet, or ingestion has not caught up. Three different sentences,
 *     three different states, and a `0` that stood for all three would be the
 *     product lying quietly.
 */

export interface AnalyticsQueryOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: AnalyticsPolicy;
  readonly registry: AnalyticsRegistry;
  readonly clock?: Clock;
}

/** Why a metric has no value. Machine codes; the dashboard translates them. */
export type MetricAbsenceReason =
  /** The platform does not publish this figure at all. */
  | 'not_published_by_platform'
  /** Nothing has been published in this window, so there is nothing to measure. */
  | 'no_published_content'
  /** Published, but no reading has arrived yet. */
  | 'metrics_pending'
  /** A derived metric whose components are not both present. */
  | 'components_missing'
  /** No connected account can be asked. */
  | 'no_connection'
  /** The connection needs the customer to authorize again. */
  | 'connection_needs_reauthorization';

export interface MetricValue {
  readonly metricKey: string;
  /** Null means MISSING. Zero means the provider reported zero. */
  readonly value: bigint | null;
  readonly unit: MetricUnit;
  /** Set only when `value` is null. */
  readonly absent: MetricAbsenceReason | null;
  /** The comparison window's value, when one was asked for. */
  readonly previousValue: bigint | null;
  /**
   * Change against the comparison window, in parts per mille. Null when either
   * side is missing or the baseline is zero — a change from nothing is not a
   * percentage, and rendering one would be arithmetic dressed as insight.
   */
  readonly changeMilli: number | null;
  /** How many observations the value was computed from. Zero means none. */
  readonly observationCount: number;
}

export interface AnalyticsPeriod {
  readonly start: Date;
  readonly end: Date;
}

export interface AnalyticsScope {
  readonly brandId?: string | undefined;
  readonly campaignId?: string | undefined;
  readonly socialConnectionId?: string | undefined;
  readonly provider?: SocialProvider | undefined;
  readonly contentItemId?: string | undefined;
  readonly subjectType?: MetricSubjectType | undefined;
}

export interface AnalyticsSummary {
  readonly period: AnalyticsPeriod;
  readonly comparison: AnalyticsPeriod | null;
  readonly metrics: readonly MetricValue[];
  /** The worst freshness of any connection contributing to this answer. */
  readonly freshness: AnalyticsFreshness;
  readonly lastSyncedAt: Date | null;
  /** True when any contributing observation came from a MOCK source. */
  readonly containsMockData: boolean;
  /** Connections contributing, and how many of them need reauthorization. */
  readonly connectionCount: number;
  readonly connectionsNeedingReauth: number;
}

export interface TimeSeriesPoint {
  readonly periodStart: Date;
  /** Null for a bucket with no observation. The chart shows a GAP, not a zero. */
  readonly value: bigint | null;
}

export interface TimeSeries {
  readonly metricKey: string;
  readonly unit: MetricUnit;
  readonly granularity: MetricGranularity;
  readonly points: readonly TimeSeriesPoint[];
  readonly absent: MetricAbsenceReason | null;
}

interface AggregateRow {
  readonly metricKey: string;
  readonly unit: MetricUnit;
  readonly total: bigint | null;
  readonly latest: bigint | null;
  readonly observations: bigint;
}

export class AnalyticsQueryService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: AnalyticsPolicy;
  readonly #registry: AnalyticsRegistry;
  readonly #clock: Clock;

  constructor(options: AnalyticsQueryOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#registry = options.registry;
    this.#clock = options.clock ?? systemClock;
  }

  get policy(): AnalyticsPolicy {
    return this.#policy;
  }

  /**
   * The `where` every read in this file starts from.
   *
   * ONE BUILDER, so the scope rule cannot be implemented once per query and get a
   * different answer on the fifth. `brandIdQueryFilter` returns an `AND`, so the
   * caller's brand filter and their authorization scope INTERSECT — the defect
   * that helper exists to prevent is precisely two spreads where the later key
   * silently replaced the earlier one.
   */
  #where(scope: AnalyticsScope, brandScope: readonly string[], period: AnalyticsPeriod) {
    return {
      workspaceId: this.#workspaceId,
      ...brandIdQueryFilter({ brandId: scope.brandId, brandScope }),
      ...(scope.socialConnectionId ? { socialConnectionId: scope.socialConnectionId } : {}),
      ...(scope.provider ? { provider: scope.provider } : {}),
      ...(scope.contentItemId ? { contentItemId: scope.contentItemId } : {}),
      ...(scope.subjectType ? { subjectType: scope.subjectType } : {}),
      /*
       * A CAMPAIGN FILTER IS A JOIN, NOT A COLUMN. `metric_observation` carries no
       * `campaignId`: an observation belongs to a post, and the post belongs to a
       * campaign. Denormalising it would mean a post moved between campaigns
       * leaves its old figures behind under the old campaign, and the two views
       * would disagree for ever. The relation filter is still a PREDICATE — it
       * becomes an `EXISTS` in SQL, so no foreign row is read and discarded.
       */
      ...(scope.campaignId ? { item: { is: { campaignId: scope.campaignId } } } : {}),
      periodStart: { gte: period.start },
      periodEnd: { lte: period.end },
    };
  }

  /**
   * Totals and rates over a window, optionally against a comparison window.
   *
   * THE ORDER OF OPERATIONS MATTERS. Ingested metrics are aggregated first;
   * derived metrics are computed AFTERWARDS from those aggregates, never
   * averaged from per-row rates. "Total engagements over total impressions" is
   * the engagement rate for the period; "the mean of the daily rates" is a
   * different number that happens to look similar, and on a week with one
   * enormous day they differ enormously.
   */
  async summary(input: {
    scope: AnalyticsScope;
    period: AnalyticsPeriod;
    comparison?: AnalyticsPeriod | undefined;
    granularity?: MetricGranularity | undefined;
    brandScope: readonly string[];
    metricKeys?: readonly string[] | undefined;
  }): Promise<AnalyticsSummary> {
    // D-132: refuse an explicitly named out-of-scope brand the way a missing one
    // is refused, BEFORE any query runs.
    if (input.scope.brandId) assertBrandInScope(input.brandScope, input.scope.brandId);

    const granularity = input.granularity ?? 'DAY';
    const current = await this.#aggregate(input.scope, input.brandScope, input.period, granularity);
    const previous = input.comparison
      ? await this.#aggregate(input.scope, input.brandScope, input.comparison, granularity)
      : new Map<string, AggregateRow>();

    const context = await this.#context(input.scope, input.brandScope, input.period);

    const requested = input.metricKeys ?? [
      ...new Set([...current.keys(), ...DERIVED_METRICS.map((m) => m.key)]),
    ];

    const metrics: MetricValue[] = [];
    for (const metricKey of requested) {
      const definition = findMetric(metricKey);
      if (!definition) continue;

      if (definition.derivedFrom) {
        metrics.push(this.#derivedValue(metricKey, current, previous, context));
        continue;
      }

      const row = current.get(metricKey);
      const value = row ? (isAdditive(metricKey) ? row.total : row.latest) : null;
      const prior = previous.get(metricKey);
      const previousValue = prior ? (isAdditive(metricKey) ? prior.total : prior.latest) : null;

      metrics.push({
        metricKey,
        value,
        unit: definition.unit,
        absent: value === null ? this.#absenceReason(metricKey, context) : null,
        previousValue,
        changeMilli: changeInMilli(value, previousValue),
        observationCount: row ? Number(row.observations) : 0,
      });
    }

    return {
      period: input.period,
      comparison: input.comparison ?? null,
      metrics,
      freshness: context.freshness,
      lastSyncedAt: context.lastSyncedAt,
      containsMockData: context.containsMockData,
      connectionCount: context.connectionCount,
      connectionsNeedingReauth: context.connectionsNeedingReauth,
    };
  }

  /**
   * A metric over time, one point per bucket.
   *
   * A BUCKET WITH NO OBSERVATION IS `null`, NOT `0`. A chart that drew zero for a
   * day nobody posted would be claiming a measurement of no engagement, when the
   * truth is that there was nothing to measure. Rendering a gap is the honest
   * shape, and it is the shape the accessible table renders too.
   */
  async series(input: {
    scope: AnalyticsScope;
    period: AnalyticsPeriod;
    metricKey: string;
    granularity?: MetricGranularity | undefined;
    brandScope: readonly string[];
  }): Promise<TimeSeries> {
    if (input.scope.brandId) assertBrandInScope(input.brandScope, input.scope.brandId);

    const granularity = input.granularity ?? 'DAY';
    const definition = findMetric(input.metricKey);
    if (!definition) {
      return {
        metricKey: input.metricKey,
        unit: 'COUNT',
        granularity,
        points: [],
        absent: 'not_published_by_platform',
      };
    }

    const context = await this.#context(input.scope, input.brandScope, input.period);

    if (definition.derivedFrom) {
      const numerator = await this.series({
        ...input,
        metricKey: definition.derivedFrom.numerator,
        granularity,
      });
      const denominator = await this.series({
        ...input,
        metricKey: definition.derivedFrom.denominator,
        granularity,
      });
      const byStart = new Map(
        denominator.points.map((p) => [p.periodStart.toISOString(), p.value]),
      );
      return {
        metricKey: input.metricKey,
        unit: definition.unit,
        granularity,
        points: numerator.points.map((point) => {
          const bottom = byStart.get(point.periodStart.toISOString());
          const value =
            point.value === null || bottom === null || bottom === undefined
              ? null
              : computeDerived(input.metricKey, {
                  [definition.derivedFrom!.numerator]: point.value,
                  [definition.derivedFrom!.denominator]: bottom,
                });
          return { periodStart: point.periodStart, value };
        }),
        absent:
          numerator.points.length === 0 ? this.#absenceReason(input.metricKey, context) : null,
      };
    }

    const rows = await this.#db.metricObservation.groupBy({
      by: ['periodStart'],
      where: {
        ...this.#where(input.scope, input.brandScope, input.period),
        metricKey: input.metricKey,
        granularity,
      },
      _sum: { value: true },
      orderBy: { periodStart: 'asc' },
    });

    /*
     * A SERIES BUCKET IS ALREADY "LATEST", SO IT IS A SUM — AND NEVER A MAX
     * (P7-R7).
     *
     * `observationKey` is unique per (subject, metric, granularity, periodStart),
     * so within ONE bucket each subject contributes exactly one reading: the
     * reading FOR that bucket. Combining them across subjects is the declared
     * rule for both kinds of metric — add the accounts' impressions, add the
     * accounts' follower counts — so one `_sum` is correct for both, and the
     * `_max` that used to serve the level case was simply the wrong number
     * (the largest ACCOUNT, not the brand's total).
     *
     * The "latest" part of a level's semantics belongs to the WINDOW, where
     * `#latestPerSubject` applies it; a time series is asking a different
     * question and must not answer it by flattening the window.
     */
    const points = rows.map((row) => ({
      periodStart: row.periodStart,
      value: row._sum.value ?? null,
    }));

    return {
      metricKey: input.metricKey,
      unit: definition.unit,
      granularity,
      points,
      absent: points.length === 0 ? this.#absenceReason(input.metricKey, context) : null,
    };
  }

  /**
   * The best and worst performing posts in a window.
   *
   * ORDERED BY A METRIC THE CALLER NAMES, and only over posts this workspace
   * published. Every row is reachable through the same scope predicate as the
   * aggregates, so a brand-restricted member's "top posts" contains only their
   * own brands' posts — and the ordering is done in the database rather than over
   * a list that was read wider and trimmed.
   */
  async topPosts(input: {
    scope: AnalyticsScope;
    period: AnalyticsPeriod;
    metricKey: string;
    limit: number;
    direction?: 'desc' | 'asc';
    brandScope: readonly string[];
  }): Promise<
    readonly {
      contentItemId: string;
      brandId: string;
      provider: SocialProvider;
      value: bigint;
      unit: MetricUnit;
      title: string | null;
      publishedAt: Date | null;
    }[]
  > {
    if (input.scope.brandId) assertBrandInScope(input.brandScope, input.scope.brandId);
    const definition = findMetric(input.metricKey);
    if (!definition || definition.derivedFrom) return [];

    const grouped = await this.#db.metricObservation.groupBy({
      by: ['contentItemId', 'brandId', 'provider'],
      where: {
        ...this.#where({ ...input.scope, subjectType: 'POST' }, input.brandScope, input.period),
        metricKey: input.metricKey,
        contentItemId: { not: null },
      },
      _sum: { value: true },
      orderBy: { _sum: { value: input.direction ?? 'desc' } },
      // F5 — read a few more than asked, because an archived or expired post
      // is dropped below and the observations carry no relation to filter on.
      take: Math.max(1, Math.min(input.limit * 4, 200)),
    });

    const candidateIds = grouped.flatMap((row) => (row.contentItemId ? [row.contentItemId] : []));
    if (candidateIds.length === 0) return [];

    // A SECOND SCOPED READ, not a join through an unscoped client. The titles come
    // back under the same RLS and the same brand predicate the aggregate used —
    // and only for LIVE posts (F5): an archived or expired post is not a "top
    // post" any more than it is a published one.
    const items = await this.#db.contentItem.findMany({
      where: {
        workspaceId: this.#workspaceId,
        id: { in: candidateIds },
        deletedAt: null,
        status: { not: 'ARCHIVED' },
        ...brandIdQueryFilter({ brandScope: input.brandScope }),
      },
      select: { id: true, title: true },
    });
    const titles = new Map(items.map((item) => [item.id, item.title]));
    const live = grouped
      .filter((row) => row.contentItemId !== null && titles.has(row.contentItemId))
      .slice(0, Math.max(1, Math.min(input.limit, 50)));
    const itemIds = live.flatMap((row) => (row.contentItemId ? [row.contentItemId] : []));

    const jobs = await this.#db.publishJob.findMany({
      where: {
        workspaceId: this.#workspaceId,
        contentItemId: { in: itemIds },
        status: 'PUBLISHED',
      },
      select: { contentItemId: true, publishedAt: true },
    });
    const publishedAt = new Map(jobs.map((job) => [job.contentItemId, job.publishedAt]));

    return live.flatMap((row) => {
      if (!row.contentItemId) return [];
      const value = row._sum.value;
      if (value === null) return [];
      return [
        {
          contentItemId: row.contentItemId,
          brandId: row.brandId,
          provider: row.provider,
          value,
          unit: definition.unit,
          title: titles.get(row.contentItemId) ?? null,
          publishedAt: publishedAt.get(row.contentItemId) ?? null,
        },
      ];
    });
  }

  /** Per-platform totals for one metric, for the platform-comparison surface. */
  async byProvider(input: {
    scope: AnalyticsScope;
    period: AnalyticsPeriod;
    metricKey: string;
    brandScope: readonly string[];
  }): Promise<readonly { provider: SocialProvider; value: bigint | null; unit: MetricUnit }[]> {
    if (input.scope.brandId) assertBrandInScope(input.brandScope, input.scope.brandId);
    const definition = findMetric(input.metricKey);
    if (!definition || definition.derivedFrom) return [];

    const where = {
      ...this.#where(input.scope, input.brandScope, input.period),
      metricKey: input.metricKey,
    };

    /*
     * THE SAME RESOLUTION AS THE SUMMARY (P7-R7), so a platform comparison and
     * the headline figure above it cannot disagree about what "followers" means.
     */
    if (isLevelMetric(input.metricKey)) {
      /*
       * AT THE SAME GRANULARITY THE SUMMARY USES. `byProvider` takes none, and
       * `DAY` is the grain every level metric is ingested at; asking for "the
       * latest daily reading per account" is the same question the tile above
       * this comparison answers.
       */
      const latest = await this.#latestPerSubject(where, input.metricKey, 'DAY');
      if (!latest) return [];
      return [...latest.byProvider.entries()].map(([provider, value]) => ({
        provider,
        value,
        unit: definition.unit,
      }));
    }

    const rows = await this.#db.metricObservation.groupBy({
      by: ['provider'],
      where,
      _sum: { value: true },
    });

    return rows.map((row) => ({
      provider: row.provider,
      value: row._sum.value ?? null,
      unit: definition.unit,
    }));
  }

  /** One window's aggregates, keyed by metric. */
  async #aggregate(
    scope: AnalyticsScope,
    brandScope: readonly string[],
    period: AnalyticsPeriod,
    granularity: MetricGranularity,
  ): Promise<Map<string, AggregateRow>> {
    const where = { ...this.#where(scope, brandScope, period), granularity };
    const rows = await this.#db.metricObservation.groupBy({
      by: ['metricKey', 'unit'],
      where,
      _sum: { value: true },
      _count: { _all: true },
    });

    const out = new Map<string, AggregateRow>();
    for (const row of rows) {
      /*
       * `latest` IS COMPUTED ONLY FOR THE METRICS THAT HAVE ONE (P7-R7).
       *
       * It used to be `MAX(value)` for every metric, taken in the same pass —
       * cheap, and wrong for exactly the metric that needed it. A level's window
       * value is each SUBJECT'S most recent reading, added across subjects, so
       * it needs its own two-query resolution and gets one. A flow has no
       * "latest" at all and is now `null` rather than a maximum nobody should
       * read.
       */
      const latest = isLevelMetric(row.metricKey)
        ? await this.#latestPerSubject(where, row.metricKey, granularity)
        : null;

      out.set(row.metricKey, {
        metricKey: row.metricKey,
        unit: row.unit,
        total: row._sum.value ?? null,
        latest: latest === null ? null : latest.total,
        observations: BigInt(row._count._all),
      });
    }
    return out;
  }

  /**
   * EACH SUBJECT'S MOST RECENT READING IN THE WINDOW, ADDED UP.
   *
   * THE SEMANTICS, stated so a test can assert them directly. A brand with two
   * Instagram accounts and one LinkedIn account, asked for `followers` over
   * March: take each account's LAST March reading — not its largest, not its
   * first — and add the three. An account that lost followers contributes the
   * number it ended March with.
   *
   * TWO QUERIES, AND NEITHER READS A ROW IT THEN DISCARDS. The first asks the
   * database for each subject's latest `periodStart`; the second fetches exactly
   * those observations. `observationKey` is UNIQUE per
   * (workspace, connection, subject, metric, granularity, periodStart), so each
   * (subject, latest period) pair identifies exactly ONE row — there is no
   * tie to break and no second ordering to get wrong.
   *
   * THE SUBJECT IS (connection, external id), not the connection alone: one
   * connection can carry several measured subjects, and collapsing them would
   * drop all but one.
   *
   * It returns the per-provider split as well, because `byProvider` needs the
   * same reading and must not compute it a second way.
   */
  async #latestPerSubject(
    where: Prisma.MetricObservationWhereInput,
    metricKey: string,
    granularity: MetricGranularity,
  ): Promise<{
    total: bigint | null;
    byProvider: Map<SocialProvider, bigint>;
    observations: number;
  } | null> {
    /*
     * ONE GRANULARITY, NAMED BY THE CALLER, AND IT IS NOT OPTIONAL.
     *
     * `observationKey` is unique per (subject, metric, GRANULARITY, periodStart),
     * so a subject that carries both a DAY and a MONTH reading for the same
     * instant has two rows — and a "latest per subject" that did not pin the
     * granularity would add both, double-counting an account. Pinning it makes
     * each (subject, latest period) pair exactly one row, which is what lets the
     * second query below be a plain fetch with no tie to break.
     */
    const scopedWhere: Prisma.MetricObservationWhereInput = { ...where, metricKey, granularity };

    const subjects = await this.#db.metricObservation.groupBy({
      by: ['socialConnectionId', 'subjectExternalId'],
      where: scopedWhere,
      _max: { periodStart: true },
    });
    if (subjects.length === 0) return null;

    const pairs = subjects.flatMap((subject) =>
      subject._max.periodStart === null
        ? []
        : [
            {
              socialConnectionId: subject.socialConnectionId,
              subjectExternalId: subject.subjectExternalId,
              periodStart: subject._max.periodStart,
            },
          ],
    );
    /* c8 ignore next -- a grouped subject always has a max period. */
    if (pairs.length === 0) return null;

    const rows = await this.#db.metricObservation.findMany({
      where: { ...scopedWhere, OR: pairs },
      select: { provider: true, value: true },
    });

    let total = 0n;
    const byProvider = new Map<SocialProvider, bigint>();
    for (const row of rows) {
      total += row.value;
      byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0n) + row.value);
    }
    return { total, byProvider, observations: rows.length };
  }

  #derivedValue(
    metricKey: string,
    current: Map<string, AggregateRow>,
    previous: Map<string, AggregateRow>,
    context: ScopeContext,
  ): MetricValue {
    const definition = findMetric(metricKey);
    /* c8 ignore next -- callers only pass catalogue keys. */
    if (!definition?.derivedFrom) {
      return {
        metricKey,
        value: null,
        unit: 'COUNT',
        absent: 'components_missing',
        previousValue: null,
        changeMilli: null,
        observationCount: 0,
      };
    }

    const components = (source: Map<string, AggregateRow>) => ({
      [definition.derivedFrom!.numerator]:
        source.get(definition.derivedFrom!.numerator)?.total ?? undefined,
      [definition.derivedFrom!.denominator]:
        source.get(definition.derivedFrom!.denominator)?.total ?? undefined,
    });

    const value = computeDerived(metricKey, components(current));
    const previousValue = computeDerived(metricKey, components(previous));

    return {
      metricKey,
      value,
      unit: definition.unit,
      absent: value === null ? this.#absenceReason(metricKey, context) : null,
      previousValue,
      changeMilli: changeInMilli(value, previousValue),
      observationCount: current.get(definition.derivedFrom.numerator)?.observations
        ? Number(current.get(definition.derivedFrom.numerator)?.observations)
        : 0,
    };
  }

  /**
   * WHY there is no number, in order of what the customer can do about it.
   *
   * "This platform does not publish that" is permanent and needs no action;
   * "you have not published anything" needs content; "no reading yet" needs
   * patience; "reconnect" needs a click. Collapsing them into one empty state
   * would mean the product never tells anyone which of the four they are in.
   */
  #absenceReason(metricKey: string, context: ScopeContext): MetricAbsenceReason {
    const definition = findMetric(metricKey);
    if (definition?.derivedFrom) return 'components_missing';

    if (context.connectionCount === 0) return 'no_connection';
    if (
      context.providers.length > 0 &&
      !context.providers.some((p) => providerSupportsMetric(p, metricKey))
    ) {
      return 'not_published_by_platform';
    }
    if (
      context.connectionsNeedingReauth === context.connectionCount &&
      context.connectionCount > 0
    ) {
      return 'connection_needs_reauthorization';
    }
    if (context.publishedPostCount === 0) return 'no_published_content';
    return 'metrics_pending';
  }

  /** Everything the absence and freshness answers depend on, read once. */
  async #context(
    scope: AnalyticsScope,
    brandScope: readonly string[],
    period: AnalyticsPeriod,
  ): Promise<ScopeContext> {
    const connections = await this.#db.socialConnection.findMany({
      where: {
        workspaceId: this.#workspaceId,
        ...brandIdQueryFilter({ brandId: scope.brandId, brandScope }),
        ...(scope.socialConnectionId ? { id: scope.socialConnectionId } : {}),
        ...(scope.provider ? { provider: scope.provider } : {}),
        status: { in: ['ACTIVE', 'NEEDS_REAUTH'] },
      },
      select: { id: true, provider: true, status: true },
    });

    const cursors = await this.#db.analyticsIngestionCursor.findMany({
      where: {
        workspaceId: this.#workspaceId,
        ...brandIdQueryFilter({ brandId: scope.brandId, brandScope }),
        ...(scope.socialConnectionId ? { socialConnectionId: scope.socialConnectionId } : {}),
      },
      select: { lastSucceededAt: true },
    });

    // F5 — the same live list Home counts: posts, not per-channel jobs.
    const publishedPostCount = await countPublishedPosts(this.#db, {
      workspaceId: this.#workspaceId,
      brandId: scope.brandId,
      brandScope,
      contentItemId: scope.contentItemId,
      period: { end: period.end },
    });

    const mock = await this.#db.metricObservation.count({
      where: { ...this.#where(scope, brandScope, period), sourceKind: 'MOCK' },
    });

    const succeeded = cursors
      .map((c) => c.lastSucceededAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime());

    // THE WORST FRESHNESS WINS. A brand summed from four accounts is exactly as
    // current as its stalest contributor, and claiming otherwise would put a
    // "fresh" badge on a number that is partly three days old.
    const oldest =
      succeeded.length === cursors.length && succeeded.length > 0
        ? succeeded[succeeded.length - 1]
        : null;

    return {
      providers: [...new Set(connections.map((c) => c.provider))],
      connectionCount: connections.length,
      connectionsNeedingReauth: connections.filter((c) => c.status === 'NEEDS_REAUTH').length,
      publishedPostCount,
      containsMockData: mock > 0,
      lastSyncedAt: succeeded[0] ?? null,
      freshness: freshnessFor(this.#policy, oldest, this.#clock),
    };
  }

  /** Which providers this workspace can be asked about at all, right now. */
  availableProviders(): readonly SocialProvider[] {
    return this.#registry.availableProviders();
  }
}

interface ScopeContext {
  readonly providers: readonly SocialProvider[];
  readonly connectionCount: number;
  readonly connectionsNeedingReauth: number;
  readonly publishedPostCount: number;
  readonly containsMockData: boolean;
  readonly lastSyncedAt: Date | null;
  readonly freshness: AnalyticsFreshness;
}

/**
 * Period-over-period change, in parts per mille.
 *
 * NULL WHEN THE BASELINE IS ZERO OR MISSING, and that is not a convenience. A
 * change from zero is not a percentage — it is undefined — and every product
 * that renders it as "+∞%" or "+100%" is inventing a comparison. The honest
 * answer is "no comparison available", which the UI renders as such.
 */
export function changeInMilli(current: bigint | null, previous: bigint | null): number | null {
  if (current === null || previous === null) return null;
  if (previous === 0n) return null;
  const delta = current - previous;
  // Integer arithmetic throughout, then one conversion at the end: the values
  // are bounded by what a platform reports and cannot overflow a double here.
  return Number((delta * 1000n) / (previous < 0n ? -previous : previous));
}
