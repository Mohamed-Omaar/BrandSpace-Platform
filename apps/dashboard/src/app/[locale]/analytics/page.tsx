import Link from 'next/link';
import type { CSSProperties } from 'react';
import { CopilotLink } from '../../../components/copilot-link';
import {
  ChartDataTable,
  CountUp,
  PlatformIcon,
  SegmentPill,
  StateMessage,
  visuallyHiddenStyle,
  type ChartLabels,
  type ChartPoint,
  type SocialPlatform,
} from '@brandspace/ui';
import { brandScopeFilter, systemClock, maySpendCredits } from '@brandspace/shared';
import {
  countPublishedPosts,
  detectAnomalies,
  type MetricAbsenceReason,
} from '@brandspace/analytics';
import { requireWorkspacePage } from '../../../server/customer-context';
import { firstPictures } from '../../../server/first-pictures';
import { NoAccessPage } from '../../../components/no-access-page';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inAnalytics } from '../../../server/analytics-context';
import {
  evidenceRefs,
  optionalMessage,
  statusMessage,
  translator,
  type MessageKey,
} from '../../../i18n/messages';
import { analyticsNextSteps, latestShift } from '../../../server/performance-patterns';
import { measuredChanges, parseExplanation, pickText } from '../../../server/analytics-story';
import { FiltersDisclosure } from '../../../components/filters-disclosure';
import { explainPeriodAction, saveInsightLearningAction } from './actions';
import { copilotHref } from '../../../server/copilot-surface';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { bestPostingHours, channelChart, pillarTotals } from '../../../server/performance-view';
import { dayFormatter, dayLabel, whenFormatter } from '../../../server/prototype-dates';

import { EmptyAction } from '../../../components/empty-action';

export const dynamic = 'force-dynamic';

/**
 * SMART ANALYTICS — brand, platform and post performance.
 *
 * WHO MAY OPEN IT: a member holding `analytics.read`, and nobody else. A Viewer
 * (read-only) holds `workspace.read` and nothing else (D-62, D-130), so they
 * reach the same NOT_FOUND any member without the permission gets.
 *
 * BRANDSCOPE IS A QUERY PREDICATE ON EVERY READ (D-132/D-134). The brand picker,
 * every aggregate, the series and the top posts are all filtered in the database.
 * It matters more here than anywhere else in the product: an aggregate computed
 * over rows the reader may not see and then filtered afterwards is already a
 * leak — the number has been produced, and no later filter can un-produce it.
 *
 * EVERY EMPTY STATE NAMES ITS REASON. A metric with no value says which of six
 * things is true — the platform does not publish it, nothing was published, the
 * reading has not arrived, a component is missing, there is no connection, or the
 * account needs reconnecting. A plausible-looking zero standing for all six is
 * exactly what this phase exists not to ship.
 *
 * IT STATES WHEN ITS NUMBERS ARE NOT REAL. Until a real analytics credential is
 * approved (D-18, D-19), the figures come from a deterministic mock source, and
 * the screen says so in a banner rather than implying a platform reported them.
 */

const RANGES = [7, 28, 90] as const;
type Range = (typeof RANGES)[number];

/**
 * The metrics the overview leads with — the prototype's Reach · Engagement rate
 * · (Posts published) · New followers (round 3). Everything else is on the
 * tables; `clicks` is read for the posts table, not drawn as a figure.
 */
const HEADLINE_METRICS = ['reach', 'engagement_rate', 'follower_change'] as const;
const SUMMARY_METRICS = [...HEADLINE_METRICS, 'clicks'] as const;

function parseRange(value: unknown): Range {
  const days = Number(value);
  return (RANGES as readonly number[]).includes(days) ? (days as Range) : 28;
}

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const access = await requireWorkspacePage(locale, '/analytics');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const session = access.session;
  const { workspace } = session;

  const days = parseRange(query['range']);
  const compare = query['compare'] !== '0';
  const mayExport = workspace.permissionKeys.includes('analytics.export');
  // Q18 — explaining a period spends credits, so it also needs `copilot.use`.
  const mayExplain = maySpendCredits(workspace.permissionKeys, 'analytics.explain');
  // D11 (Phase 2C-4) — saving an insight as a learning proposes a fact.
  const mayLearn = workspace.permissionKeys.includes('brand_brain.edit');
  // Findings are read only by a member who may read insights (F-10).
  const mayReadInsights = workspace.permissionKeys.includes('strategy.read');
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const error = typeof query['error'] === 'string' ? query['error'] : null;

  /*
   * THE BRANDS THIS MEMBER MAY ACT ON — filtered by `brandScopeFilter`, which
   * filters the BRAND table by `id` rather than a child by `brandId`. A picker
   * offering a brand every query would then refuse is the dead control §20
   * forbids.
   */
  /*
   * THE GLOBAL BRAND CONTEXT, NOT A SECOND PICKER (D-190).
   *
   * This screen used to list the brands itself and fall back to `brands[0]`,
   * which meant the toolbar's dropdown and the rail could disagree about which
   * brand the reader was looking at — and the fallback made "no brand chosen"
   * look like "this brand's numbers". `?brand=` still works and still wins, so
   * every existing deep link and the CSV export href behave exactly as before.
   */
  const brandContext = await brandContextFor(
    session.workspace,
    '/analytics',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const brand = requiredBrand(brandContext);

  const number = new Intl.NumberFormat('en-US');
  const percent = new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const day = dayFormatter(locale, 'UTC', systemClock.now());
  const stamp = whenFormatter(locale, 'UTC', systemClock.now());

  const formatValue = (value: bigint | null, unit: string): string | null => {
    if (value === null) return null;
    // A rate is stored in parts per mille; everything else is a plain tally.
    if (unit === 'RATIO_MILLI') return percent.format(Number(value) / 1_000);
    if (unit === 'SECONDS') return `${number.format(Number(value))}s`;
    return number.format(Number(value));
  };

  const absentText = (reason: MetricAbsenceReason | null): string =>
    reason ? t(`analytics.absent.${reason}` as MessageKey) : t('analytics.noValue');

  if (!brand) {
    const unselected = brandContext.resolution.kind === 'unselected';

    return (
      <WorkspaceShell
        brandContext={brandContext}
        locale={locale}
        heading={t('analytics.title')}
        description={t('analytics.subtitle')}
        activePath="/analytics"
        workspaceName={workspace.workspaceName}
        roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
        customerName={session.customer.name ?? session.customer.email}
        permissionKeys={workspace.permissionKeys}
      >
        <StateMessage
          kind="empty"
          title={unselected ? t('brand.chooseTitle') : t('analytics.noBrandTitle')}
          description={unselected ? t('brand.chooseBody') : t('analytics.noBrandBody')}
          action={
            brandContext.resolution.kind === 'empty' &&
            workspace.permissionKeys.includes('brand.manage') ? (
              <EmptyAction
                href={`/${locale}/brand-brain`}
                label={t('bb.createBrand')}
                testId="no-brand-create"
              />
            ) : undefined
          }
        />
      </WorkspaceShell>
    );
  }

  const data = await inAnalytics(workspace.workspaceId, async (services) => {
    const queries = await services.queries();
    const now = systemClock.now();
    const period = { start: new Date(now.getTime() - days * 86_400_000), end: now };
    const comparison = compare
      ? { start: new Date(period.start.getTime() - days * 86_400_000), end: period.start }
      : undefined;

    /*
     * ROUND 3 (B8) — THE ACCOUNT'S OWN READINGS for the headline figures and
     * the reach lines: a post's reach is part of its account's, so summing the
     * two would count the same people twice.
     */
    const summary = await queries.summary({
      scope: { brandId: brand.id, subjectType: 'ACCOUNT' },
      period,
      ...(comparison ? { comparison } : {}),
      brandScope: workspace.brandScope,
      metricKeys: SUMMARY_METRICS,
    });

    const series = await queries.series({
      scope: { brandId: brand.id },
      period,
      metricKey: 'engagements',
      brandScope: workspace.brandScope,
    });

    const byProvider = await queries.byProvider({
      scope: { brandId: brand.id },
      period,
      metricKey: 'engagements',
      brandScope: workspace.brandScope,
    });

    /*
     * ONE ROW PER POST (round 3): the query ranks a post on each channel; the
     * prototype's table lists the post once with its channels, its figure the
     * sum over them.
     */
    const rankedOnChannels = await queries.topPosts({
      scope: { brandId: brand.id },
      period,
      metricKey: 'engagements',
      limit: 20,
      brandScope: workspace.brandScope,
    });
    const topPosts = [
      ...rankedOnChannels
        .reduce((posts, row) => {
          const seen = posts.get(row.contentItemId);
          posts.set(
            row.contentItemId,
            seen
              ? {
                  ...seen,
                  value: seen.value + row.value,
                  providers: [...seen.providers, row.provider],
                }
              : { ...row, providers: [row.provider] },
          );
          return posts;
        }, new Map<string, (typeof rankedOnChannels)[number] & { providers: (typeof rankedOnChannels)[number]['provider'][] }>())
        .values(),
    ]
      .sort((a, b) => Number(b.value - a.value))
      .slice(0, 5);

    /*
     * ROUND 3 (B8) — WHAT THE PROTOTYPE'S PERFORMANCE SCREEN READS, from the
     * same queries and the same brand scope: reach per channel and per day
     * (one line each), the posts' own figures for the table and the pillar and
     * best-time cards, the posts published, and the campaigns' rates.
     */
    const reachByProvider = await queries.byProvider({
      scope: { brandId: brand.id, subjectType: 'ACCOUNT' },
      period,
      metricKey: 'reach',
      brandScope: workspace.brandScope,
    });
    const reachSeries = await queries.series({
      scope: { brandId: brand.id, subjectType: 'ACCOUNT' },
      period,
      metricKey: 'reach',
      brandScope: workspace.brandScope,
    });
    const reachByChannel = await Promise.all(
      reachByProvider.map(async (row) => ({
        provider: row.provider,
        series: await queries.series({
          scope: { brandId: brand.id, provider: row.provider, subjectType: 'ACCOUNT' },
          period,
          metricKey: 'reach',
          brandScope: workspace.brandScope,
        }),
      })),
    );
    const postFigures = async (metricKey: string) => {
      const sums = new Map<string, (typeof rankedOnChannels)[number]>();
      for (const row of await queries.topPosts({
        scope: { brandId: brand.id },
        period,
        metricKey,
        limit: 200,
        brandScope: workspace.brandScope,
      })) {
        const seen = sums.get(row.contentItemId);
        sums.set(row.contentItemId, seen ? { ...seen, value: seen.value + row.value } : row);
      }
      return sums;
    };
    const [postEngagements, postReach, postSaves, postClicks] = await Promise.all([
      postFigures('engagements'),
      postFigures('reach'),
      postFigures('saves'),
      postFigures('clicks'),
    ]);
    const postIds = [...postEngagements.keys()];
    const postMeta =
      postIds.length > 0
        ? await services.db.contentItem.findMany({
            where: {
              workspaceId: workspace.workspaceId,
              id: { in: postIds },
              ...brandScopeFilter(workspace.brandScope),
            },
            select: { id: true, pillar: true, campaign: { select: { name: true } } },
          })
        : [];
    const postsPublished = await countPublishedPosts(services.db, {
      workspaceId: workspace.workspaceId,
      brandId: brand.id,
      brandScope: workspace.brandScope,
      period,
    });
    const campaignRates = await queries.campaignEngagementRates({
      brandId: brand.id,
      brandScope: workspace.brandScope,
    });
    const campaignRows =
      campaignRates.size > 0
        ? await services.db.campaign.findMany({
            where: {
              workspaceId: workspace.workspaceId,
              id: { in: [...campaignRates.keys()] },
              deletedAt: null,
              ...brandScopeFilter(workspace.brandScope),
            },
            select: { id: true, name: true, status: true },
          })
        : [];
    const zone =
      (
        await services.db.workspace.findUnique({
          where: { id: workspace.workspaceId },
          select: { timezone: true },
        })
      )?.timezone ?? 'UTC';

    /*
     * INSIGHTS ARE READ ONLY WHEN THE READER MAY SEE THEM. A count fetched and
     * then dropped in JavaScript is a disclosure computed over rows this person
     * may not see (F-10).
     */
    const insights = workspace.permissionKeys.includes('strategy.read')
      ? await services.db.insight.findMany({
          where: {
            workspaceId: workspace.workspaceId,
            brandId: brand.id,
            type: { in: ['ANALYTICS_EXPLANATION', 'ANOMALY', 'RECOMMENDATION'] },
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, type: true, status: true, basis: true, createdAt: true },
        })
      : [];

    /*
     * WHAT CHANGED (P6-11). The same arithmetic the insight service and the
     * learning rules use, over the series this screen already drew, with the
     * thresholds from this tenant's analytics configuration. It spends nothing
     * and can be checked by eye against the chart above it.
     */
    const policy = await services.policy();
    const shift = latestShift(
      detectAnomalies({
        metricKey: series.metricKey,
        unit: series.unit,
        points: series.points,
        policy,
      }),
      { now, withinDays: days },
    );

    /*
     * D-293 — THE LATEST EXPLANATION a person has not dismissed, for the
     * story at the top. Its claims were checked against its evidence before it
     * was stored; it is read only by a member who may read insights.
     */
    const explanation = workspace.permissionKeys.includes('strategy.read')
      ? await services.db.insight.findFirst({
          where: {
            workspaceId: workspace.workspaceId,
            brandId: brand.id,
            type: 'ANALYTICS_EXPLANATION',
            status: { in: ['NEW', 'SEEN', 'ACCEPTED'] },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, body: true, periodStart: true, periodEnd: true },
        })
      : null;

    /*
     * D11 (Phase 2C-4) — WHAT EACH INSIGHT HAS ALREADY BEEN SAVED AS: the
     * LEARNINGS candidates carrying its id, read only for a member who may
     * save one (`brand_brain.edit`). PENDING reads "saved · waiting for
     * review"; an accepted one reads "saved".
     */
    const learnings =
      insights.length > 0 && workspace.permissionKeys.includes('brand_brain.edit')
        ? await services.db.brandKnowledgeCandidate.findMany({
            where: {
              insightId: { in: insights.map((insight) => insight.id) },
              area: 'LEARNINGS',
              status: { in: ['PENDING', 'ACCEPTED', 'EDITED_ACCEPTED'] },
            },
            select: { insightId: true, status: true },
          })
        : [];

    return {
      summary,
      series,
      byProvider,
      topPosts,
      reachByProvider,
      reachSeries,
      reachByChannel,
      postEngagements,
      postReach,
      postSaves,
      postClicks,
      postMeta,
      postsPublished,
      campaignRates,
      campaignRows,
      zone,
      insights,
      period,
      shift,
      explanation,
      learnings,
    };
  });

  const learningState = (insightId: string): 'none' | 'pending' | 'accepted' => {
    const rows = data.learnings.filter((row) => row.insightId === insightId);
    if (rows.some((row) => row.status === 'PENDING')) return 'pending';
    return rows.length > 0 ? 'accepted' : 'none';
  };

  const nextSteps = analyticsNextSteps({
    absences: [...data.summary.metrics.map((metric) => metric.absent), data.series.absent],
    shift: data.shift,
    unreviewedFindings: data.insights.filter((insight) => insight.status === 'NEW').length,
    permissionKeys: workspace.permissionKeys,
  });

  const exportHref = `/${locale}/analytics/export?brand=${brand.id}&range=${days}`;

  const changes = compare ? measuredChanges(data.summary.metrics) : [];
  // "Explain the shift" is the Why card's own action now; listing it here too
  // would be the same button twice.
  const trySteps = nextSteps.filter((step) => step.key !== 'explain-shift');
  const topPost = data.topPosts[0] ?? null;
  const explained = parseExplanation(data.explanation?.body ?? null);
  const cites = (refs: readonly number[]) =>
    refs.length > 0 ? ` · ${t('strategy.rests')} ${evidenceRefs(locale, refs)}` : '';

  /*
   * D-468 — THE PROTOTYPE'S PERFORMANCE SCREEN (`Main.dc.html` lines 661–756).
   * Numbers and Insights, the period and Export are links, so the view, the
   * range and the comparison are all in the address, as the filters were.
   */
  const view: 'numbers' | 'insights' =
    query['view'] === 'insights' && mayReadInsights ? 'insights' : 'numbers';
  const hrefWith = (change: Record<string, string | null>): string => {
    const next = new URLSearchParams({
      brand: brand.id,
      range: String(days),
      ...(compare ? {} : { compare: '0' }),
      ...(view === 'insights' ? { view: 'insights' } : {}),
    });
    for (const [key, value] of Object.entries(change)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    return `/${locale}/analytics?${next.toString()}`;
  };
  const mayRepeat = workspace.permissionKeys.includes('content.create');

  /* ROUND 3 (B8) — the prototype's figures, sections and their scales. */
  const metricOf = (key: string) => data.summary.metrics.find((metric) => metric.metricKey === key);
  const kpis = [
    metricOf('reach'),
    metricOf('engagement_rate'),
    {
      metricKey: 'posts_published',
      value: null,
      unit: 'COUNT',
      absent: null,
      changeMilli: null,
    } as const,
    metricOf('follower_change'),
  ].filter((metric): metric is NonNullable<typeof metric> => metric !== undefined);
  const reachDay = (points: readonly { periodStart: Date; value: bigint | null }[]) =>
    points.map((point) => ({
      label: day.format(point.periodStart),
      value: point.value === null ? null : Number(point.value),
    }));
  const reachPoints: readonly ChartPoint[] = data.reachSeries.points.map((point) => ({
    label: day.format(point.periodStart),
    value: point.value === null ? null : Number(point.value),
    formatted: formatValue(point.value, 'COUNT') ?? undefined,
    absentLabel: absentText(data.reachSeries.absent),
  }));
  const reachLabels: ChartLabels = {
    title: t('analytics.reachDayByDay'),
    description: `${t('analytics.trend')} — ${t('analytics.metric.reach')}`,
    tableCaption: `${t('analytics.trend')} — ${t('analytics.metric.reach')}`,
    periodColumn: t('analytics.tablePeriod'),
    valueColumn: t('analytics.tableValue'),
    noValue: t('analytics.noValue'),
  };
  const channelLines = channelChart(
    data.reachByChannel.map((entry) => ({
      key: entry.provider.toLowerCase(),
      points: reachDay(entry.series.points),
    })),
  );
  const reachTotal = data.reachByProvider.reduce(
    (sum, row) => sum + (row.value === null ? 0 : Number(row.value)),
    0,
  );
  const reachMax = Math.max(
    1,
    ...data.reachByProvider.map((row) => (row.value === null ? 0 : Number(row.value))),
  );
  const postMetaById = new Map(data.postMeta.map((row) => [row.id, row] as const));
  /*
   * Round 4 (5.8) — THE POSTS TABLE SHOWS EACH POST'S COVER: its first
   * picture, through the same expiring inline grant Approvals uses
   * (`firstPictures`), for a member who may read the library. A post with no
   * picture keeps the prototype's art square.
   */
  const topItemIds = data.topPosts.map((post) => post.contentItemId);
  const firstAsset = new Map<string, string>();
  if (topItemIds.length > 0) {
    const variants = await inAnalytics(workspace.workspaceId, async (services) =>
      services.db.contentVariant.findMany({
        where: {
          contentItemId: { in: topItemIds },
          ...brandScopeFilter(workspace.brandScope),
        },
        orderBy: { createdAt: 'asc' },
        select: { contentItemId: true, assetIds: true },
      }),
    ).catch(() => []);
    for (const variant of variants) {
      const id = variant.assetIds[0];
      if (id && !firstAsset.has(variant.contentItemId)) firstAsset.set(variant.contentItemId, id);
    }
  }
  const covers = await firstPictures({
    locale,
    workspaceId: workspace.workspaceId,
    actor: {
      userId: session.customer.userId,
      permissionKeys: workspace.permissionKeys,
      brandScope: workspace.brandScope,
    },
    assetIds: [...firstAsset.values()],
  }).catch(() => new Map());
  const coverOf = (itemId: string) => {
    const asset = firstAsset.get(itemId);
    return asset ? covers.get(asset) : undefined;
  };
  const engagementPosts = [...data.postEngagements.values()];
  const pillars = pillarTotals(
    engagementPosts.map((post) => ({
      pillar: postMetaById.get(post.contentItemId)?.pillar ?? null,
      value: Number(post.value),
    })),
  );
  const pillarMax = Math.max(1, ...pillars.map((row) => row.total));
  const best = bestPostingHours(
    engagementPosts.map((post) => ({ publishedAt: post.publishedAt, value: Number(post.value) })),
    data.zone,
  );
  const bestMax = Math.max(1, ...best.map((slot) => slot.average));
  const campaigns = data.campaignRows
    .flatMap((row) => {
      const rate = data.campaignRates.get(row.id);
      return rate ? [{ ...row, rateMilli: rate.rateMilli }] : [];
    })
    .sort((a, b) => Number(b.rateMilli - a.rateMilli));
  const campaignMax = Math.max(1, ...campaigns.map((row) => Number(row.rateMilli)));

  const story = (
    <div className="bsp-pf-story">
      <section className="bsp-xcard bsp-pf-card" data-testid="analytics-what-changed">
        <h2 className="bsp-sech">{t('analytics.story.changed')}</h2>
        {changes.length === 0 && !data.shift && explained.notableChanges.length === 0 ? (
          <p className="bsp-pf-muted" data-testid="analytics-nothing-changed">
            {compare ? t('analytics.story.nothingChanged') : t('analytics.story.noComparison')}
          </p>
        ) : (
          <ul className="bsp-pf-list">
            {changes.map((change) => (
              <li key={change.metricKey} data-testid={`analytics-change-${change.metricKey}`}>
                {t(change.changeMilli > 0 ? 'analytics.story.rose' : 'analytics.story.fell')
                  .replace('{metric}', t(`analytics.metric.${change.metricKey}` as MessageKey))
                  .replace('{change}', percent.format(Math.abs(change.changeMilli) / 1_000))
                  .replace('{days}', number.format(days))}
              </li>
            ))}
            {data.shift ? (
              <li data-testid="analytics-shift">
                <span
                  className={`bsp-xstatus ${data.shift.direction === 'above' ? '' : 'bsp-warn'}`}
                >
                  {t(`analytics.shift.${data.shift.direction}` as MessageKey)}
                </span>{' '}
                {t('analytics.shift.body')
                  .replace('{metric}', t(`analytics.metric.${data.shift.metricKey}` as MessageKey))
                  .replace('{day}', day.format(data.shift.periodStart))
                  .replace('{observed}', number.format(Number(data.shift.observedValue)))
                  .replace('{baseline}', number.format(Number(data.shift.baselineValue)))
                  .replace('{periods}', number.format(data.shift.baselinePeriods))
                  .replace('{deviation}', percent.format(data.shift.deviationMilli / 1_000))
                  .replace('{threshold}', percent.format(data.shift.thresholdMilli / 1_000))}
              </li>
            ) : null}
            {topPost ? (
              <li data-testid="analytics-top-post">
                {t('analytics.story.topPost')
                  .replace('{title}', topPost.title ?? t('publishing.untitled'))
                  .replace('{value}', number.format(Number(topPost.value)))}
              </li>
            ) : null}
            {explained.notableChanges.map((line, index) => (
              <li key={`n${index}`} dir="auto">
                {pickText(line.text, locale)}
                {cites(line.evidenceRefs)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bsp-xcard bsp-pf-card" data-testid="analytics-why">
        <h2 className="bsp-sech">{t('analytics.story.why')}</h2>
        {explained.claims.length > 0 || explained.summary ? (
          <>
            {explained.summary ? (
              <p className="bsp-pf-text" dir="auto">
                {pickText(explained.summary, locale)}
              </p>
            ) : null}
            <ul className="bsp-pf-list">
              {explained.claims.map((line, index) => (
                <li key={index} dir="auto">
                  {pickText(line.text, locale)}
                  {cites(line.evidenceRefs)}
                </li>
              ))}
            </ul>
            <p className="bsp-pf-muted">{t('analytics.story.correlation')}</p>
          </>
        ) : (
          <>
            <p className="bsp-pf-muted">{t('analytics.story.noExplanation')}</p>
            {mayExplain ? (
              <span className="bsp-pf-acts">
                <ExplainForm
                  locale={locale}
                  brandId={brand.id}
                  days={days}
                  compare={compare}
                  label={t('analytics.explain')}
                  testId="analytics-explain-shift"
                />
                <span className="bsp-pf-muted">{t('analytics.explainHint')}</span>
              </span>
            ) : null}
          </>
        )}
      </section>

      <section className="bsp-xcard bsp-pf-card" data-testid="analytics-next">
        <span className="bsp-pf-cardh">
          <h2 className="bsp-sech">{t('analytics.story.try')}</h2>
          {workspace.permissionKeys.includes('copilot.use') ? (
            <CopilotLink
              href={copilotHref(locale, 'analytics')}
              className="bsp-btn bsp-sm bsp-ghost bsp-pf-link"
              data-testid="analytics-ask-copilot"
            >
              {t('home.recommended.giveToCopilot')}
            </CopilotLink>
          ) : null}
        </span>
        {explained.recommendations.length === 0 && trySteps.length === 0 ? (
          <p className="bsp-pf-muted">{t('analytics.story.nothingToTry')}</p>
        ) : (
          <ul className="bsp-pf-list">
            {explained.recommendations.map((line, index) => (
              <li key={`r${index}`} className="bsp-pf-try" data-testid={`analytics-try-${index}`}>
                <span dir="auto">
                  {pickText(line.text, locale)}
                  {cites(line.evidenceRefs)}
                </span>
                {data.explanation ? (
                  <Link
                    href={`/${locale}/intelligence?insight=${data.explanation.id}`}
                    className="bsp-pf-a"
                  >
                    {t('home.recommended.viewEvidence')}
                  </Link>
                ) : null}
              </li>
            ))}
            {trySteps.map((step) => (
              <li key={step.key} className="bsp-pf-step" data-testid={`analytics-next-${step.key}`}>
                <span>{t(`analytics.next.${step.key}` as MessageKey)}</span>
                {step.href ? (
                  <Link href={`/${locale}${step.href}`} className="bsp-btn bsp-sm bsp-sec">
                    {t(`analytics.next.${step.key}.action` as MessageKey)}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );

  return (
    <WorkspaceShell
      /*
       * THE BRAND CONTEXT, ON THE PATH THAT HAS ONE (D-190): one shell, one
       * selector, on every route.
       */
      brandContext={brandContext}
      locale={locale}
      eyebrow={t('nav.group.improve')}
      heading={t('nav.rail.performance')}
      activePath="/analytics"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={session.customer.name ?? session.customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <div className="bsp-pf">
        {/*
         * THE HONESTY BANNERS. One says the numbers did not come from a
         * platform, the other says they are older than the configured window.
         */}
        {ok ? (
          <CustomerBanner tone="success">{statusMessage(ok, locale) ?? ok}</CustomerBanner>
        ) : null}
        {error ? (
          <CustomerBanner tone="error">{statusMessage(error, locale) ?? error}</CustomerBanner>
        ) : null}
        {data.summary.containsMockData ? (
          <CustomerBanner tone="warning">{t('analytics.mockNotice')}</CustomerBanner>
        ) : null}
        {data.summary.freshness === 'STALE' ? (
          <CustomerBanner tone="warning">{t('analytics.staleNotice')}</CustomerBanner>
        ) : null}

        {/* The head row: Numbers · Insights, the period, the comparison, Export. */}
        <div className="bsp-pf-top" data-testid="analytics-filters">
          <nav className="bsp-seg" aria-label={t('analytics.views')} data-testid="analytics-views">
            <SegmentPill selector='[aria-current="page"]' />
            <Link
              href={hrefWith({ view: null })}
              aria-current={view === 'numbers' ? 'page' : undefined}
            >
              {t('analytics.numbers')}
            </Link>
            {mayReadInsights ? (
              <Link
                href={hrefWith({ view: 'insights' })}
                aria-current={view === 'insights' ? 'page' : undefined}
                data-testid="analytics-view-insights"
              >
                {t('insights.title')}{' '}
                <span className="bsp-ltr bsp-pf-count">{number.format(data.insights.length)}</span>
              </Link>
            ) : null}
          </nav>
          <nav
            className="bsp-seg"
            aria-label={t('analytics.rangeLabel')}
            data-testid="analytics-range"
          >
            <SegmentPill selector='[aria-current="page"]' />
            {RANGES.map((option) => (
              <Link
                key={option}
                href={hrefWith({ range: String(option) })}
                aria-current={option === days ? 'page' : undefined}
                data-testid={`analytics-range-${option}`}
              >
                {t(`analytics.range.${option}` as MessageKey)}
              </Link>
            ))}
          </nav>
          {/*
            Review of #67 — the prototype's head row has no comparison chip; the
            product's "Compare with the previous period" is under Filters, which
            counts it while it is switched off (the default compares).
          */}
          <FiltersDisclosure
            label={t('content.p.filters')}
            active={compare ? 0 : 1}
            testId="analytics-filters-toggle"
          >
            <Link
              href={hrefWith({ compare: compare ? '0' : null })}
              className="bsp-chip bsp-pf-chip"
              aria-pressed={compare}
              role="button"
              data-testid="analytics-compare"
            >
              {t('analytics.compareLabel')}
            </Link>
          </FiltersDisclosure>
          {mayExport ? (
            <a
              href={exportHref}
              className="bsp-btn bsp-sm bsp-pf-export"
              data-testid="analytics-export"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />
              </svg>
              {t('analytics.export')}
            </a>
          ) : null}
        </div>

        {view === 'numbers' ? (
          <>
            {/*
              WHERE THE NUMBERS COME FROM — the prototype's sources strip: the
              channels that reported in this period, how fresh the figures are,
              and the promise that a missing figure says why, never a zero.
            */}
            <section className="bsp-pf-src" data-testid="analytics-sources">
              <div className="bsp-pf-src-row">
                {data.byProvider.map((row) => (
                  <span key={row.provider} className="bsp-pf-src-chip">
                    {platformOf(row.provider) ? (
                      <PlatformIcon platform={platformOf(row.provider)!} size={12} />
                    ) : null}
                    <b className="bsp-ltr">
                      {t(`integrations.provider.${row.provider.toLowerCase()}` as MessageKey)}
                    </b>
                  </span>
                ))}
                <span
                  className={`bsp-xstatus ${FRESHNESS_X[data.summary.freshness]}`}
                  data-testid="analytics-freshness"
                >
                  {t('analytics.freshness')}:{' '}
                  {t(`analytics.freshness.${data.summary.freshness}` as MessageKey)}
                </span>
                {data.summary.lastSyncedAt ? (
                  <span className="bsp-pf-src-note">
                    {t('analytics.lastSynced')}: {stamp.format(data.summary.lastSyncedAt)}
                  </span>
                ) : null}
              </div>
              <span className="bsp-pf-src-note">{t('analytics.sourcesNote')}</span>
            </section>

            {/*
              ROUND 3 (B8) — THE PROTOTYPE'S FOUR FIGURES: Reach · Engagement
              rate · Posts published · New followers (`.xcard`, `padding: 16px
              18px; gap: 4px`). A figure with no reading says why, never 0.
            */}
            <div className="bsp-xgrid bsp-pf-kpis">
              {kpis.map((metric) => {
                const value =
                  metric.metricKey === 'posts_published'
                    ? number.format(data.postsPublished)
                    : formatValue(metric.value, metric.unit);
                const spark = metric.metricKey === 'reach' ? sparkPath(reachPoints) : null;
                return (
                  <section
                    key={metric.metricKey}
                    className="bsp-xcard bsp-pf-kpi"
                    data-testid={`analytics-metric-${metric.metricKey}`}
                  >
                    <span className="bsp-pf-kpi-l">
                      {optionalMessage(messageLocale, `analytics.kpi.${metric.metricKey}`) ??
                        t(`analytics.metric.${metric.metricKey}` as MessageKey)}
                    </span>
                    {value === null ? (
                      <span className="bsp-pf-kpi-none">{absentText(metric.absent)}</span>
                    ) : (
                      <span className="bsp-ltr bsp-xnum">
                        {/* MO12 (D-351): the figure counts up to the exact server value. */}
                        <CountUp value={value} />
                      </span>
                    )}
                    <span className="bsp-pf-kpi-row">
                      <span
                        className="bsp-pf-delta"
                        data-direction={
                          metric.changeMilli === null
                            ? 'none'
                            : metric.changeMilli >= 0
                              ? 'up'
                              : 'down'
                        }
                      >
                        {metric.changeMilli === null
                          ? '—'
                          : `${metric.changeMilli >= 0 ? '↑ +' : '↓ '}${percent.format(metric.changeMilli / 1_000)}`}
                      </span>
                      {spark ? (
                        <svg width="120" height="30" viewBox="0 0 120 30" aria-hidden="true">
                          <path d={spark} className="bsp-pf-spark" />
                        </svg>
                      ) : null}
                    </span>
                    <span className="bsp-pf-kpi-vs">{t('analytics.vsPrev')}</span>
                  </section>
                );
              })}
            </div>

            {/*
              "REACH, DAY BY DAY" — the prototype's 900×230 chart with one line
              per channel and its legend; the total's table for assistive tech.
            */}
            <section className="bsp-xcard bsp-pf-chartcard">
              <div className="bsp-pf-cardh bsp-pf-charth">
                <h2 className="bsp-sech">{t('analytics.reachDayByDay')}</h2>
                <span className="bsp-pf-sub">{t('analytics.reachDaySub')}</span>
                {channelLines && channelLines.lines.length > 1 ? (
                  <span className="bsp-pf-legend">
                    {channelLines.lines.map((line) => (
                      <span key={line.key} className="bsp-ltr" data-provider={line.key}>
                        <span className="bsp-pf-legend-l" aria-hidden="true" />
                        {t(`integrations.provider.${line.key}` as MessageKey)}
                      </span>
                    ))}
                  </span>
                ) : null}
              </div>
              {channelLines === null ? (
                <p className="bsp-pf-muted">
                  {t('analytics.emptyTitle')} — {absentText(data.reachSeries.absent)}
                </p>
              ) : (
                <figure className="bsp-pf-chart" data-testid="analytics-trend" dir="ltr">
                  <svg
                    viewBox="0 0 900 230"
                    width="100%"
                    role="img"
                    aria-label={reachLabels.description}
                  >
                    {channelLines.grid.map((line) => (
                      <g key={line.y}>
                        <line x1="48" x2="830" y1={line.y} y2={line.y} className="bsp-pf-grid" />
                        <text x="40" y={line.y + 4} textAnchor="end" className="bsp-pf-axis">
                          {line.label}
                        </text>
                      </g>
                    ))}
                    {channelLines.xlabels.map((label) => (
                      <text
                        key={label.x}
                        x={label.x}
                        y="224"
                        textAnchor="middle"
                        className="bsp-pf-axis"
                      >
                        {label.label}
                      </text>
                    ))}
                    {/* MO11 (D-351): each line draws in, its end value pops in after it. */}
                    {channelLines.lines.map((line) => (
                      <g key={line.key} className="bs-chart-line" data-dir="ltr">
                        {line.paths.map((d) => (
                          <path key={d} d={d} className="bsp-pf-line" data-provider={line.key} />
                        ))}
                        {line.end ? (
                          <text x={line.end.x} y={line.end.y} className="bsp-pf-endv bs-chart-dot">
                            {line.end.label}
                          </text>
                        ) : null}
                      </g>
                    ))}
                  </svg>
                  <div style={visuallyHiddenStyle()}>
                    <ChartDataTable labels={reachLabels} points={reachPoints} />
                  </div>
                </figure>
              )}
            </section>

            {/* By channel · By strategy pillar · Best time to post (lines 702–717). */}
            <div className="bsp-pf-three">
              <section className="bsp-xcard bsp-pf-card" data-testid="analytics-by-platform">
                <h2 className="bsp-sech">{t('analytics.byChannel')}</h2>
                {data.reachByProvider.length === 0 ? (
                  <p className="bsp-pf-muted">{t('analytics.absent.no_connection')}</p>
                ) : (
                  data.reachByProvider.map((row, index) => {
                    const value = row.value === null ? 0 : Number(row.value);
                    return (
                      <div
                        key={row.provider}
                        className="bsp-pf-ch"
                        data-provider={row.provider.toLowerCase()}
                      >
                        <span className="bsp-pf-ch-row">
                          {platformOf(row.provider) ? (
                            <PlatformIcon platform={platformOf(row.provider)!} size={13} />
                          ) : null}
                          <span className="bsp-ltr bsp-pf-ch-name">
                            {t(`integrations.provider.${row.provider.toLowerCase()}` as MessageKey)}
                          </span>
                          <b className="bsp-ltr">{row.value === null ? '—' : kfmt(value)}</b>
                          <span className="bsp-pf-ch-share">
                            {reachTotal > 0 ? percent.format(value / reachTotal) : '—'}
                          </span>
                        </span>
                        <span className="bsp-pf-bar">
                          {/* MO11 (D-351): each bar grows from its start edge, 35 ms apart. */}
                          <span
                            className="bs-chart-bar"
                            data-dir={locale === 'ar' ? 'rtl' : 'ltr'}
                            data-provider={row.provider.toLowerCase()}
                            style={{
                              ...({ '--i': index } as CSSProperties),
                              inlineSize: `${Math.max(2, Math.round((value / reachMax) * 100))}%`,
                            }}
                          />
                        </span>
                      </div>
                    );
                  })
                )}
                <span className="bsp-pf-foot">
                  {t('analytics.metric.reach')} · {t(`analytics.range.${days}` as MessageKey)}
                </span>
              </section>

              <section className="bsp-xcard bsp-pf-card" data-testid="analytics-by-pillar">
                <div className="bsp-pf-cardh">
                  <h2 className="bsp-sech">{t('analytics.byPillar')}</h2>
                  <Link
                    href={`/${locale}/strategy`}
                    className="bsp-btn bsp-sm bsp-ghost bsp-pf-go"
                    aria-label={t('nav.strategy')}
                  >
                    →
                  </Link>
                </div>
                {pillars.length === 0 ? (
                  <p className="bsp-pf-muted">{t('analytics.byPillarEmpty')}</p>
                ) : (
                  pillars.map((row, index) => (
                    <div key={row.pillar} className="bsp-pf-pil">
                      <span className="bsp-pf-pil-row">
                        <span dir="auto">{row.pillar}</span>
                        <b className="bsp-ltr">{kfmt(row.total)}</b>
                      </span>
                      <span className="bsp-pf-pbar">
                        <span
                          className="bs-chart-bar"
                          data-dir={locale === 'ar' ? 'rtl' : 'ltr'}
                          data-shade={index % 3}
                          style={{
                            ...({ '--i': index } as CSSProperties),
                            inlineSize: `${Math.max(2, Math.round((row.total / pillarMax) * 100))}%`,
                          }}
                        />
                      </span>
                    </div>
                  ))
                )}
                <span className="bsp-pf-foot">
                  {t('analytics.metric.engagements')} · {t(`analytics.range.${days}` as MessageKey)}
                </span>
              </section>

              <section className="bsp-xcard bsp-pf-card" data-testid="analytics-best-time">
                <h2 className="bsp-sech">{t('analytics.bestTime')}</h2>
                <span className="bsp-pf-foot bsp-pf-best-sub">
                  {t('analytics.bestTimeSub').replace(
                    '{period}',
                    t(`analytics.range.${days}` as MessageKey),
                  )}
                </span>
                {best.length === 0 ? (
                  <p className="bsp-pf-muted">{t('analytics.bestTimeEmpty')}</p>
                ) : (
                  best.map((slot, index) => (
                    <div key={slot.hour} className="bsp-pf-best">
                      <span className="bsp-ltr bsp-pf-best-t">
                        {String(slot.hour).padStart(2, '0')}:00
                      </span>
                      <span className="bsp-pf-best-bar">
                        <span
                          className="bs-chart-bar"
                          data-dir={locale === 'ar' ? 'rtl' : 'ltr'}
                          data-top={index === 0 ? 'true' : undefined}
                          style={{
                            ...({ '--i': index } as CSSProperties),
                            inlineSize: `${Math.max(2, Math.round((slot.average / bestMax) * 100))}%`,
                          }}
                        />
                      </span>
                      <span className="bsp-ltr bsp-pf-best-v">{kfmt(slot.average)}</span>
                    </div>
                  ))
                )}
                {best.length > 0 && mayRepeat ? (
                  <Link
                    href={`/${locale}/content/compose`}
                    className="bsp-btn bsp-sm bsp-sec bsp-pf-use"
                  >
                    {t('analytics.bestTimeUse')} →
                  </Link>
                ) : null}
              </section>
            </div>

            {/* Posts: the prototype's table — Post · Channel · Reach · Eng. · Saves · Clicks. */}
            <section className="bsp-xcard bsp-pf-posts" data-testid="analytics-top-posts">
              <div className="bsp-pf-posts-h">
                <h2 className="bsp-sech">{t('analytics.posts')}</h2>
                {mayExport ? <span className="bsp-pf-sub">{t('analytics.tablesNote')}</span> : null}
              </div>
              <div className="bsp-pf-tr bsp-pf-th" aria-hidden={data.topPosts.length === 0}>
                <span>{t('analytics.post')}</span>
                <span>{t('analytics.col.channel')}</span>
                <span className="bsp-pf-num">{t('analytics.metric.reach')}</span>
                <span className="bsp-pf-num">{t('analytics.col.eng')}</span>
                <span className="bsp-pf-num">{t('analytics.metric.saves')}</span>
                <span className="bsp-pf-num">{t('analytics.col.clicks')}</span>
                <span />
              </div>
              {data.topPosts.length === 0 ? (
                <div className="bsp-pf-none">{t('analytics.topPostsEmpty')}</div>
              ) : (
                data.topPosts.map((post) => {
                  const meta = postMetaById.get(post.contentItemId);
                  const figure = (row: { value: bigint } | undefined) =>
                    row ? number.format(Number(row.value)) : '—';
                  return (
                    <div key={post.contentItemId} className="bsp-pf-tr">
                      <span className="bsp-pf-post">
                        {(() => {
                          const cover = coverOf(post.contentItemId);
                          return cover?.kind === 'image' ? (
                            <img
                              className="bsp-pf-art"
                              src={cover.src}
                              alt=""
                              data-testid={`analytics-post-cover-${post.contentItemId}`}
                            />
                          ) : (
                            <span className="bsp-pf-art" aria-hidden="true" />
                          );
                        })()}
                        <span className="bsp-pf-post-t">
                          <span dir="auto" className="bsp-pf-post-n">
                            {post.title ?? post.contentItemId}
                          </span>
                          <span className="bsp-pf-post-m">
                            {post.publishedAt
                              ? dayLabel(post.publishedAt, locale, data.zone, systemClock.now())
                              : ''}
                            {meta?.campaign?.name ? ` · ${meta.campaign.name}` : ''}
                          </span>
                        </span>
                      </span>
                      <span className="bsp-pf-chs">
                        {post.providers.map((provider) =>
                          platformOf(provider) ? (
                            <PlatformIcon
                              key={provider}
                              platform={platformOf(provider)!}
                              size={13}
                            />
                          ) : (
                            <span key={provider} className="bsp-ltr">
                              {provider}
                            </span>
                          ),
                        )}
                      </span>
                      <span className="bsp-ltr bsp-pf-num bsp-pf-strong">
                        {figure(data.postReach.get(post.contentItemId))}
                      </span>
                      <span className="bsp-ltr bsp-pf-num">
                        {number.format(Number(post.value))}
                      </span>
                      <span className="bsp-ltr bsp-pf-num">
                        {figure(data.postSaves.get(post.contentItemId))}
                      </span>
                      <span className="bsp-ltr bsp-pf-num">
                        {figure(data.postClicks.get(post.contentItemId))}
                      </span>
                      <span className="bsp-pf-rowacts">
                        {mayRepeat ? (
                          <Link
                            href={`/${locale}/content/compose?${new URLSearchParams({
                              mode: 'ai',
                              source: post.contentItemId,
                            }).toString()}`}
                            className="bsp-btn bsp-sm bsp-sec"
                          >
                            {t('analytics.repeat')}
                          </Link>
                        ) : null}
                      </span>
                    </div>
                  );
                })
              )}
            </section>

            {/* Campaigns: each campaign's engagement rate, from its posts (line 739). */}
            {campaigns.length > 0 ? (
              <section className="bsp-xcard bsp-pf-card" data-testid="analytics-campaigns">
                <div className="bsp-pf-cardh">
                  <h2 className="bsp-sech">{t('analytics.campaigns')}</h2>
                  <Link
                    href={`/${locale}/campaigns`}
                    className="bsp-btn bsp-sm bsp-ghost bsp-pf-go"
                  >
                    {t('analytics.allCampaigns')} →
                  </Link>
                </div>
                {campaigns.map((campaign, index) => (
                  <Link
                    key={campaign.id}
                    href={`/${locale}/campaigns/${campaign.id}`}
                    className="bsp-pf-camp"
                  >
                    <span className="bsp-pf-camp-row">
                      <b dir="auto">{campaign.name}</b>
                      <span className="bsp-pf-camp-m">{t('analytics.metric.engagement_rate')}</span>
                      <span className="bsp-ltr bsp-pf-strong">
                        {percent.format(Number(campaign.rateMilli) / 1_000)}
                      </span>
                      <span className={`bsp-xstatus ${CAMPAIGN_X[campaign.status] ?? 'bsp-neu'}`}>
                        {t(`campaigns.status.${campaign.status}` as MessageKey)}
                      </span>
                    </span>
                    <span className="bsp-pf-camp-bar">
                      <span
                        className="bs-chart-bar"
                        data-dir={locale === 'ar' ? 'rtl' : 'ltr'}
                        style={{
                          ...({ '--i': index } as CSSProperties),
                          inlineSize: `${Math.max(2, Math.round((Number(campaign.rateMilli) / campaignMax) * 100))}%`,
                        }}
                      />
                    </span>
                  </Link>
                ))}
              </section>
            ) : null}
            {/*
              D-293 — what changed, why it might matter, what to try. Round 4
              (5.6): the prototype's Numbers tab does not draw these three, so
              they are on the Insights tab beside it — the page's own existing
              way to them. A member who cannot read insights keeps them here.
            */}
            {mayReadInsights ? null : story}
          </>
        ) : (
          /*
           * INSIGHTS — the prototype's two-column cards (lines 738–751): a
           * glyph and the finding's state, what it is, where it rests, and its
           * actions — open it with its evidence, save it as a learning.
           * Round 4 (5.6): what changed, why it might matter, what to try
           * lead it, moved here from under the numbers.
           */
          <>
            {story}
            {mayExplain ? (
              <section className="bsp-card bsp-pf-explain">
                <span className="bsp-pf-muted">
                  {t('insights.noExternalData')} {t('analytics.explainHint')}
                </span>
                <ExplainForm
                  locale={locale}
                  brandId={brand.id}
                  days={days}
                  compare={compare}
                  label={t('analytics.explain')}
                  testId="analytics-explain"
                  view="insights"
                />
              </section>
            ) : null}
            <div className="bsp-pf-ins" data-testid="analytics-insights">
              {data.insights.map((insight) => (
                <section
                  key={insight.id}
                  className="bsp-xcard bsp-pf-insight"
                  data-testid={`analytics-insight-${insight.id}`}
                >
                  <span className="bsp-pf-ins-h">
                    <span className="bsp-xicon" aria-hidden="true">
                      {INSIGHT_GLYPH[insight.type] ?? '↗'}
                    </span>
                    <span
                      className={`bsp-xstatus ${insight.status === 'NEW' ? 'bsp-ai' : 'bsp-neu'}`}
                    >
                      {t(`insights.status.${insight.status}` as MessageKey)}
                    </span>
                  </span>
                  <span className="bsp-xtitle">
                    {t(`insights.type.${insight.type}` as MessageKey)}
                  </span>
                  <span className="bsp-xdesc">
                    {t(`insights.basis.${insight.basis}` as MessageKey)} ·{' '}
                    {stamp.format(insight.createdAt)}
                  </span>
                  <div className="bsp-xfoot bsp-pf-ins-f">
                    {/*
                      TO MARKETING INTELLIGENCE, where a finding is read in full
                      with its evidence.
                    */}
                    <Link
                      href={`/${locale}/intelligence?insight=${insight.id}`}
                      className="bsp-btn bsp-sm bsp-pur"
                    >
                      {t('analytics.openInsight')}
                    </Link>
                    {mayLearn ? (
                      <SaveAsLearning
                        locale={locale}
                        brandId={brand.id}
                        insightId={insight.id}
                        range={days}
                        state={learningState(insight.id)}
                        t={t}
                      />
                    ) : null}
                  </div>
                </section>
              ))}
              {data.insights.length === 0 ? (
                <div className="bsp-card bsp-pf-insnone">{t('insights.empty')}</div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </WorkspaceShell>
  );
}

/**
 * D11 (Phase 2C-4) — "Save as learning" on one insight, or what it was saved
 * as. A plain form, like every other form on this screen; the button is shown
 * only to a member with `brand_brain.edit` and only while nothing from this
 * insight is waiting or approved, and the action re-checks both.
 */
function SaveAsLearning({
  locale,
  brandId,
  insightId,
  range,
  state,
  t,
}: {
  readonly locale: string;
  readonly brandId: string;
  readonly insightId: string;
  readonly range: number;
  readonly state: 'none' | 'pending' | 'accepted';
  readonly t: (key: MessageKey) => string;
}) {
  if (state !== 'none') {
    return (
      <span className="bsp-xstatus bsp-neu" data-testid={`insight-learning-${insightId}`}>
        {state === 'pending' ? t('insights.learningPending') : t('insights.learningSaved')}
      </span>
    );
  }
  return (
    <form action={saveInsightLearningAction} className="bsp-pf-form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="brandId" value={brandId} />
      <input type="hidden" name="insightId" value={insightId} />
      <input type="hidden" name="range" value={String(range)} />
      <input type="hidden" name="view" value="insights" />
      <button
        type="submit"
        className="bsp-btn bsp-sm bsp-sec"
        data-testid={`insight-save-learning-${insightId}`}
      >
        {t('insights.saveAsLearning')}
      </button>
    </form>
  );
}

/**
 * "Why?" — asks for an explanation of the period on screen.
 *
 * A plain form so it works without JavaScript, like every other form on this
 * screen. It spends AI credits, which is why it sits behind
 * `analytics.explain` and why the hint beside it says so; the action is
 * idempotent per brand, range and day, so a second click is not a second
 * charge.
 */
function ExplainForm({
  locale,
  brandId,
  days,
  compare,
  label,
  testId,
  view,
}: {
  locale: string;
  brandId: string;
  days: number;
  compare: boolean;
  label: string;
  testId: string;
  view?: 'insights';
}) {
  return (
    <form action={explainPeriodAction} className="bsp-pf-form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="brandId" value={brandId} />
      <input type="hidden" name="range" value={String(days)} />
      <input type="hidden" name="compare" value={compare ? '1' : '0'} />
      {view ? <input type="hidden" name="view" value={view} /> : null}
      <button type="submit" className="bsp-btn bsp-sm bsp-pur" data-testid={testId}>
        {label}
      </button>
    </form>
  );
}

/** The platforms the design system has a mark for; anything else goes without one. */
const MARKED: readonly SocialPlatform[] = ['instagram', 'facebook', 'linkedin', 'x', 'tiktok'];
function platformOf(provider: string): SocialPlatform | null {
  const key = provider.toLowerCase() as SocialPlatform;
  return MARKED.includes(key) ? key : null;
}

/** The freshness chip, in the prototype's `xstatus` tones. */
/** A campaign's status pill, as the Campaigns screen colours it. */
const CAMPAIGN_X: Readonly<Record<string, string>> = {
  ACTIVE: 'bsp-ok',
  PLANNED: 'bsp-ai',
  PAUSED: 'bsp-warn',
  COMPLETED: 'bsp-neu',
  DRAFT: 'bsp-neu',
  ARCHIVED: 'bsp-neu',
};

const FRESHNESS_X: Readonly<Record<string, string>> = {
  FRESH: '',
  STALE: 'bsp-warn',
  UNAVAILABLE: 'bsp-bad',
};

/** The prototype's insight glyphs: a performance read `↗`, a change `⌁`, a suggestion `✦`. */
const INSIGHT_GLYPH: Readonly<Record<string, string>> = {
  ANALYTICS_EXPLANATION: '↗',
  ANOMALY: '⌁',
  RECOMMENDATION: '✦',
};

/** The prototype's `kfmt`: 12K, 3.4K, 820. */
function kfmt(value: number): string {
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(Math.round(value));
}

/** The prototype's `spark`: a 120×30 polyline of the period, min to max. */
function sparkPath(points: readonly ChartPoint[]): string | null {
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  return values
    .map(
      (value, index) =>
        `${index ? 'L' : 'M'}${Math.round((index / Math.max(1, values.length - 1)) * 120)} ${Math.round(
          30 - 2 - ((value - min) / Math.max(1, max - min)) * (30 - 4),
        )}`,
    )
    .join(' ');
}
