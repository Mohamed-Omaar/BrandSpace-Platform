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
import { systemClock, maySpendCredits } from '@brandspace/shared';
import { detectAnomalies, type MetricAbsenceReason } from '@brandspace/analytics';
import { requireWorkspacePage } from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inAnalytics } from '../../../server/analytics-context';
import { evidenceRefs, statusMessage, translator, type MessageKey } from '../../../i18n/messages';
import { analyticsNextSteps, latestShift } from '../../../server/performance-patterns';
import { measuredChanges, parseExplanation, pickText } from '../../../server/analytics-story';
import { FiltersDisclosure } from '../../../components/filters-disclosure';
import { explainPeriodAction, saveInsightLearningAction } from './actions';
import { copilotHref } from '../../../server/copilot-surface';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';

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

/** The metrics the overview leads with. Everything else is on the tables. */
const HEADLINE_METRICS = ['impressions', 'reach', 'engagements', 'engagement_rate'] as const;

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

  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en');
  const percent = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en', {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const day = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const stamp = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });

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

    const summary = await queries.summary({
      scope: { brandId: brand.id },
      period,
      ...(comparison ? { comparison } : {}),
      brandScope: workspace.brandScope,
      metricKeys: HEADLINE_METRICS,
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

    const topPosts = await queries.topPosts({
      scope: { brandId: brand.id },
      period,
      metricKey: 'engagements',
      limit: 5,
      brandScope: workspace.brandScope,
    });

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

  const seriesLabels: ChartLabels = {
    title: t('analytics.metric.engagements'),
    description: `${t('analytics.trend')} — ${t('analytics.metric.engagements')}`,
    tableCaption: `${t('analytics.trend')} — ${t('analytics.metric.engagements')}`,
    periodColumn: t('analytics.tablePeriod'),
    valueColumn: t('analytics.tableValue'),
    noValue: t('analytics.noValue'),
  };

  const seriesPoints: readonly ChartPoint[] = data.series.points.map((point) => ({
    label: day.format(point.periodStart),
    value: point.value === null ? null : Number(point.value),
    formatted: formatValue(point.value, 'COUNT') ?? undefined,
    absentLabel: absentText(data.series.absent),
  }));

  const providerPoints: readonly ChartPoint[] = data.byProvider.map((row) => ({
    label: t(`integrations.provider.${row.provider.toLowerCase()}` as MessageKey),
    value: row.value === null ? null : Number(row.value),
    formatted: formatValue(row.value, 'COUNT') ?? undefined,
  }));

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
  const chart = reachChart(seriesPoints);
  const providerTotal = data.byProvider.reduce(
    (sum, row) => sum + (row.value === null ? 0 : Number(row.value)),
    0,
  );
  const providerMax = Math.max(
    1,
    ...data.byProvider.map((row) => (row.value === null ? 0 : Number(row.value))),
  );
  const mayRepeat = workspace.permissionKeys.includes('content.create');

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

            {/* The four headline figures: `.xcard` with `padding: 16px 18px; gap: 4px`. */}
            <div className="bsp-xgrid bsp-pf-kpis">
              {data.summary.metrics.map((metric) => {
                const value = formatValue(metric.value, metric.unit);
                const spark = metric.metricKey === 'engagements' ? sparkPath(seriesPoints) : null;
                return (
                  <section
                    key={metric.metricKey}
                    className="bsp-xcard bsp-pf-kpi"
                    data-testid={`analytics-metric-${metric.metricKey}`}
                  >
                    <span className="bsp-pf-kpi-l">
                      {t(`analytics.metric.${metric.metricKey}` as MessageKey)}
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

            {/* The day-by-day line: the prototype's 900×230 chart, its table for assistive tech. */}
            <section className="bsp-xcard bsp-pf-chartcard">
              <div className="bsp-pf-cardh bsp-pf-charth">
                <h2 className="bsp-sech">{t('analytics.dayByDay')}</h2>
                <span className="bsp-pf-sub">{t('analytics.metric.engagements')}</span>
              </div>
              {chart === null ? (
                <p className="bsp-pf-muted">
                  {t('analytics.emptyTitle')} — {absentText(data.series.absent)}
                </p>
              ) : (
                <figure className="bsp-pf-chart" data-testid="analytics-trend" dir="ltr">
                  <svg
                    viewBox="0 0 900 230"
                    width="100%"
                    role="img"
                    aria-label={seriesLabels.description}
                  >
                    {chart.grid.map((line) => (
                      <g key={line.y}>
                        <line x1="48" x2="830" y1={line.y} y2={line.y} className="bsp-pf-grid" />
                        <text x="40" y={line.y + 4} textAnchor="end" className="bsp-pf-axis">
                          {line.label}
                        </text>
                      </g>
                    ))}
                    {chart.xlabels.map((label) => (
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
                    {/* MO11 (D-351): the line draws in, its end value pops in after it. */}
                    <g className="bs-chart-line" data-dir="ltr">
                      {chart.paths.map((d) => (
                        <path key={d} d={d} className="bsp-pf-line" />
                      ))}
                    </g>
                    {chart.end ? (
                      <text x={chart.end.x} y={chart.end.y} className="bsp-pf-endv bs-chart-dot">
                        {chart.end.label}
                      </text>
                    ) : null}
                  </svg>
                  <div style={visuallyHiddenStyle()}>
                    <ChartDataTable labels={seriesLabels} points={seriesPoints} />
                  </div>
                </figure>
              )}
            </section>

            {/* By channel: name, figure, share and bar per platform (line 703). */}
            <section className="bsp-xcard bsp-pf-card" data-testid="analytics-by-platform">
              <h2 className="bsp-sech">{t('analytics.byPlatform')}</h2>
              {providerPoints.length === 0 ? (
                <p className="bsp-pf-muted">{t('analytics.absent.no_connection')}</p>
              ) : (
                data.byProvider.map((row, index) => {
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
                        <b className="bsp-ltr">
                          {row.value === null ? '—' : (formatValue(row.value, 'COUNT') ?? '—')}
                        </b>
                        <span className="bsp-pf-ch-share">
                          {providerTotal > 0 ? percent.format(value / providerTotal) : '—'}
                        </span>
                      </span>
                      <span className="bsp-pf-bar">
                        {/* MO11 (D-351): each bar grows from its start edge, 35 ms apart. */}
                        <span
                          className="bs-chart-bar"
                          data-dir={locale === 'ar' ? 'rtl' : 'ltr'}
                          style={{
                            ...({ '--i': index } as CSSProperties),
                            inlineSize: `${Math.max(2, Math.round((value / providerMax) * 100))}%`,
                          }}
                        />
                      </span>
                    </div>
                  );
                })
              )}
            </section>

            {/* Posts: the prototype's table, with the one figure the product ranks by. */}
            <section className="bsp-xcard bsp-pf-posts" data-testid="analytics-top-posts">
              <div className="bsp-pf-posts-h">
                <h2 className="bsp-sech">{t('analytics.topPosts')}</h2>
                {mayExport ? <span className="bsp-pf-sub">{t('analytics.tablesNote')}</span> : null}
              </div>
              <div className="bsp-pf-tr bsp-pf-th" aria-hidden={data.topPosts.length === 0}>
                <span>{t('analytics.post')}</span>
                <span className="bsp-pf-num">{t('analytics.metric.engagements')}</span>
                <span />
              </div>
              {data.topPosts.length === 0 ? (
                <div className="bsp-pf-none">{t('analytics.topPostsEmpty')}</div>
              ) : (
                data.topPosts.map((post) => (
                  <div key={post.contentItemId} className="bsp-pf-tr">
                    <span className="bsp-pf-post">
                      <span className="bsp-pf-art" aria-hidden="true" />
                      <span dir="auto">{post.title ?? post.contentItemId}</span>
                    </span>
                    <span className="bsp-ltr bsp-pf-num bsp-pf-strong">
                      {number.format(Number(post.value))}
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
                ))
              )}
            </section>
            {/*
              D-293 — what changed, why it might matter, what to try. Review of
              #67: the prototype's Numbers tab opens on the KPI cards, so the
              story, which it does not draw, follows everything it does. Every
              line is a measurement or a line of a stored explanation whose
              claims were checked.
            */}
            <div className="bsp-pf-story">
              <section className="bsp-xcard bsp-pf-card" data-testid="analytics-what-changed">
                <h2 className="bsp-sech">{t('analytics.story.changed')}</h2>
                {changes.length === 0 && !data.shift && explained.notableChanges.length === 0 ? (
                  <p className="bsp-pf-muted" data-testid="analytics-nothing-changed">
                    {compare
                      ? t('analytics.story.nothingChanged')
                      : t('analytics.story.noComparison')}
                  </p>
                ) : (
                  <ul className="bsp-pf-list">
                    {changes.map((change) => (
                      <li
                        key={change.metricKey}
                        data-testid={`analytics-change-${change.metricKey}`}
                      >
                        {t(change.changeMilli > 0 ? 'analytics.story.rose' : 'analytics.story.fell')
                          .replace(
                            '{metric}',
                            t(`analytics.metric.${change.metricKey}` as MessageKey),
                          )
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
                          .replace(
                            '{metric}',
                            t(`analytics.metric.${data.shift.metricKey}` as MessageKey),
                          )
                          .replace('{day}', day.format(data.shift.periodStart))
                          .replace('{observed}', number.format(Number(data.shift.observedValue)))
                          .replace('{baseline}', number.format(Number(data.shift.baselineValue)))
                          .replace('{periods}', number.format(data.shift.baselinePeriods))
                          .replace('{deviation}', percent.format(data.shift.deviationMilli / 1_000))
                          .replace(
                            '{threshold}',
                            percent.format(data.shift.thresholdMilli / 1_000),
                          )}
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
                      <li
                        key={`r${index}`}
                        className="bsp-pf-try"
                        data-testid={`analytics-try-${index}`}
                      >
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
                      <li
                        key={step.key}
                        className="bsp-pf-step"
                        data-testid={`analytics-next-${step.key}`}
                      >
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
          </>
        ) : (
          /*
           * INSIGHTS — the prototype's two-column cards (lines 738–751): a
           * glyph and the finding's state, what it is, where it rests, and its
           * actions — open it with its evidence, save it as a learning.
           */
          <>
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

/**
 * The prototype's day-by-day chart geometry (`CW = 900, CH = 230, PL0 = 48,
 * PR = 70, PT = 12, PB = 26`), its grid steps and its date-label thinning,
 * over the product's own series. Two departures, both about real data: a day
 * with no reading is a GAP in the line, never a zero; and below 1,000 the
 * grid steps by a quarter of the maximum, because the prototype's smallest
 * step (500) would flatten a young account's line onto the axis.
 */
function reachChart(points: readonly ChartPoint[]): {
  readonly grid: readonly { y: number; label: string }[];
  readonly xlabels: readonly { x: number; label: string }[];
  readonly paths: readonly string[];
  readonly end: { x: number; y: number; label: string } | null;
} | null {
  if (points.length === 0 || points.every((point) => point.value === null)) return null;
  const CW = 900;
  const CH = 230;
  const PL0 = 48;
  const PR = 70;
  const PT = 12;
  const PB = 26;
  const pw = CW - PL0 - PR;
  const ph = CH - PT - PB;
  let ymax = Math.max(...points.map((point) => point.value ?? 0));
  const step =
    ymax > 8000
      ? 2000
      : ymax > 4000
        ? 1000
        : ymax > 1000
          ? 500
          : Math.max(1, Math.ceil(ymax / 4 / 5) * 5);
  ymax = Math.ceil(ymax / step) * step || step;
  const X = (i: number) => PL0 + (points.length === 1 ? pw / 2 : (i / (points.length - 1)) * pw);
  const Y = (v: number) => PT + ph - (v / ymax) * ph;
  const grid: { y: number; label: string }[] = [];
  for (let g = 0; g <= ymax; g += step) grid.push({ y: Y(g), label: kfmt(g) });
  const n = points.length;
  const every = n <= 28 ? 7 : 21;
  const xlabels = points
    .map((point, i) => ({ i, label: point.label }))
    .filter((entry) => n <= 7 || entry.i % every === (n - 1) % every)
    .map((entry) => ({ x: X(entry.i), label: entry.label }));
  const paths: string[] = [];
  let current = '';
  points.forEach((point, i) => {
    if (point.value === null) {
      if (current) paths.push(current);
      current = '';
      return;
    }
    current += `${current ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(point.value).toFixed(1)} `;
  });
  if (current) paths.push(current.trim());
  const lastIndex = points.map((point) => point.value !== null).lastIndexOf(true);
  const last = points[lastIndex];
  return {
    grid,
    xlabels,
    paths,
    end:
      last && last.value !== null
        ? { x: X(lastIndex) + 8, y: Y(last.value) + 4, label: kfmt(last.value) }
        : null,
  };
}
