import Link from 'next/link';
import {
  Card,
  ChartUnavailable,
  ComparisonChart,
  ContentGrid,
  MetricCard,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  TrendChart,
  buttonStyle,
  colorTokens,
  spacingTokens,
  typographyTokens,
  type ChartLabels,
  type ChartPoint,
} from '@brandspace/ui';
import { brandScopeFilter, systemClock } from '@brandspace/shared';
import type { MetricAbsenceReason } from '@brandspace/analytics';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { inAnalytics } from '../../../server/analytics-context';
import { translator, type MessageKey } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';

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
  const t = translator(locale);
  const session = await requireWorkspace(locale, 'analytics.read');
  const { workspace } = session;

  const direction = locale === 'ar' ? 'rtl' : 'ltr';
  const days = parseRange(query['range']);
  const compare = query['compare'] !== '0';
  const mayExport = workspace.permissionKeys.includes('analytics.export');
  const mayExplain = workspace.permissionKeys.includes('analytics.explain');

  /*
   * THE BRANDS THIS MEMBER MAY ACT ON — filtered by `brandScopeFilter`, which
   * filters the BRAND table by `id` rather than a child by `brandId`. A picker
   * offering a brand every query would then refuse is the dead control §20
   * forbids.
   */
  const brands = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.brand.findMany({
      where: { status: 'ACTIVE', ...brandScopeFilter(workspace.brandScope) },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
  );

  const requested = typeof query['brand'] === 'string' ? query['brand'] : null;
  const brand = brands.find((candidate) => candidate.id === requested) ?? brands[0] ?? null;

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
    return (
      <WorkspaceShell
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
          title={t('analytics.noBrandTitle')}
          description={t('analytics.noBrandBody')}
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

    return { summary, series, byProvider, topPosts, insights, period };
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

  const providerLabels: ChartLabels = {
    title: t('analytics.byPlatform'),
    description: `${t('analytics.byPlatform')} — ${t('analytics.metric.engagements')}`,
    tableCaption: `${t('analytics.byPlatform')} — ${t('analytics.metric.engagements')}`,
    periodColumn: t('analytics.byPlatform'),
    valueColumn: t('analytics.tableValue'),
    noValue: t('analytics.noValue'),
  };

  const providerPoints: readonly ChartPoint[] = data.byProvider.map((row) => ({
    label: t(`integrations.provider.${row.provider.toLowerCase()}` as MessageKey),
    value: row.value === null ? null : Number(row.value),
    formatted: formatValue(row.value, 'COUNT') ?? undefined,
  }));

  const exportHref = `/${locale}/analytics/export?brand=${brand.id}&range=${days}`;

  return (
    <WorkspaceShell
      locale={locale}
      heading={t('analytics.title')}
      description={t('analytics.subtitle')}
      activePath="/analytics"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={session.customer.name ?? session.customer.email}
      permissionKeys={workspace.permissionKeys}
      meta={
        <StatusBadge
          tone={
            data.summary.freshness === 'FRESH'
              ? 'success'
              : data.summary.freshness === 'STALE' || data.summary.freshness === 'UNAVAILABLE'
                ? 'warning'
                : 'neutral'
          }
          label={`${t('analytics.freshness')}: ${t(`analytics.freshness.${data.summary.freshness}` as MessageKey)}`}
        />
      }
    >
      <Stack gap={spacingTokens.lg}>
        {/*
         * THE HONESTY BANNERS. Neither is decoration: one says the numbers did
         * not come from a platform, the other says they are older than the
         * configured window. A screen that drew them silently would be a screen
         * that lied by omission.
         */}
        {data.summary.containsMockData ? (
          <CustomerBanner tone="warning">{t('analytics.mockNotice')}</CustomerBanner>
        ) : null}
        {data.summary.freshness === 'STALE' ? (
          <CustomerBanner tone="warning">{t('analytics.staleNotice')}</CustomerBanner>
        ) : null}

        {/*
         * THE FILTERS, AS A GET FORM. No scripting required: the range and the
         * brand are in the URL, which also makes the export link carry exactly
         * what the screen shows.
         */}
        <form method="get" data-testid="analytics-filters">
          <fieldset
            style={{
              border: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexWrap: 'wrap',
              gap: spacingTokens.md,
              alignItems: 'end',
            }}
          >
            <label style={{ display: 'grid', gap: '0.25rem' }}>
              <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                {t('analytics.brandLabel')}
              </span>
              <select name="brand" defaultValue={brand.id} className="bs-control">
                {brands.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'grid', gap: '0.25rem' }}>
              <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                {t('analytics.rangeLabel')}
              </span>
              <select name="range" defaultValue={String(days)} className="bs-control">
                {RANGES.map((option) => (
                  <option key={option} value={option}>
                    {t(`analytics.range.${option}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="checkbox" name="compare" value="1" defaultChecked={compare} />
              <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                {t('analytics.compareLabel')}
              </span>
            </label>
            <button type="submit" style={buttonStyle('neutral', 'sm')}>
              {t('analytics.apply')}
            </button>
            {mayExport ? (
              <Link
                href={exportHref}
                style={buttonStyle('ghost', 'sm')}
                data-testid="analytics-export"
              >
                {t('analytics.export')}
              </Link>
            ) : null}
          </fieldset>
        </form>

        <SectionHeader title={t('analytics.totals')} />
        <ContentGrid>
          {data.summary.metrics.map((metric) => (
            <MetricCard
              key={metric.metricKey}
              testId={`analytics-metric-${metric.metricKey}`}
              label={t(`analytics.metric.${metric.metricKey}` as MessageKey)}
              {...(metric.value === null
                ? {
                    /*
                     * `unavailable` RATHER THAN A ZERO, and the label says WHICH
                     * of the six reasons applies. The card already knows how to
                     * render "we cannot show this"; what Phase 7 adds is that the
                     * reason is never guessed.
                     */
                    unavailable: true,
                    unavailableLabel: absentText(metric.absent),
                  }
                : { value: formatValue(metric.value, metric.unit) ?? '' })}
              {...(metric.changeMilli === null
                ? {}
                : {
                    trend: {
                      direction:
                        metric.changeMilli > 0
                          ? ('up' as const)
                          : metric.changeMilli < 0
                            ? ('down' as const)
                            : ('flat' as const),
                      label: percent.format(metric.changeMilli / 1_000),
                    },
                  })}
            />
          ))}
        </ContentGrid>

        <Card>
          <SectionHeader title={t('analytics.trend')} />
          {seriesPoints.length === 0 ? (
            <ChartUnavailable
              title={t('analytics.emptyTitle')}
              body={absentText(data.series.absent)}
            />
          ) : (
            <TrendChart
              labels={seriesLabels}
              points={seriesPoints}
              direction={direction}
              testId="analytics-trend"
            />
          )}
        </Card>

        <Card>
          <SectionHeader title={t('analytics.byPlatform')} />
          {providerPoints.length === 0 ? (
            <ChartUnavailable
              title={t('analytics.emptyTitle')}
              body={t('analytics.absent.no_connection')}
            />
          ) : (
            <ComparisonChart
              labels={providerLabels}
              points={providerPoints}
              direction={direction}
              testId="analytics-by-platform"
            />
          )}
        </Card>

        <Card>
          <SectionHeader title={t('analytics.topPosts')} />
          {data.topPosts.length === 0 ? (
            <StateMessage kind="empty" title={t('analytics.topPostsEmpty')} />
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: spacingTokens.sm,
              }}
            >
              {data.topPosts.map((post) => (
                <li
                  key={post.contentItemId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: spacingTokens.md,
                    ...typographyTokens.bodySm,
                  }}
                >
                  <span style={{ color: colorTokens.textPrimary }}>
                    {post.title ?? post.contentItemId}
                  </span>
                  <span style={{ color: colorTokens.textSecondary }}>
                    {number.format(Number(post.value))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {data.summary.lastSyncedAt ? (
          <p style={{ ...typographyTokens.caption, color: colorTokens.textMuted, margin: 0 }}>
            {t('analytics.lastSynced')}: {stamp.format(data.summary.lastSyncedAt)}
          </p>
        ) : null}

        {mayExplain || data.insights.length > 0 ? (
          <Card>
            <SectionHeader title={t('insights.title')} />
            <p style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
              {t('insights.noExternalData')}
            </p>
            {data.insights.length === 0 ? (
              <StateMessage kind="empty" title={t('insights.empty')} />
            ) : (
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'grid',
                  gap: spacingTokens.sm,
                }}
              >
                {data.insights.map((insight) => (
                  <li key={insight.id} style={{ ...typographyTokens.bodySm }}>
                    <Link href={`/${locale}/strategy?insight=${insight.id}`}>
                      {t(`insights.status.${insight.status}` as MessageKey)} ·{' '}
                      {t(`insights.basis.${insight.basis}` as MessageKey)} ·{' '}
                      {stamp.format(insight.createdAt)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </Stack>
    </WorkspaceShell>
  );
}
