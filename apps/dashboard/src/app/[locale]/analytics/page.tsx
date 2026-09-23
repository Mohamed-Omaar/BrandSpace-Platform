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
  buttonClass,
  buttonStyle,
  colorTokens,
  spacingTokens,
  typographyTokens,
  type ChartLabels,
  type ChartPoint,
} from '@brandspace/ui';
import { systemClock } from '@brandspace/shared';
import { detectAnomalies, type MetricAbsenceReason } from '@brandspace/analytics';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inAnalytics } from '../../../server/analytics-context';
import { statusMessage, translator, type MessageKey } from '../../../i18n/messages';
import { analyticsNextSteps, latestShift } from '../../../server/performance-patterns';
import { explainPeriodAction } from './actions';
import { copilotHref } from '../../../server/copilot-surface';
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

    return { summary, series, byProvider, topPosts, insights, period, shift };
  });

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
      /*
       * THE BRAND CONTEXT, ON THE PATH THAT HAS ONE.
       *
       * It was passed on this page's no-brand branch and dropped here, so the
       * two screens most about a brand lost the Brand Selector from the rail
       * the MOMENT a brand was actually chosen — a reader could pick a brand
       * and then have no way to change it without leaving the page. One shell,
       * one selector, on every route (D-190).
       */
      brandContext={brandContext}
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
            {/*
              NO BRAND DROPDOWN HERE ANY MORE (D-190). The brand is the rail's
              selection, and a second control setting the same thing is how the
              two came to disagree. It is carried through this GET form as a
              hidden field so applying a RANGE does not silently drop the brand
              the reader deep-linked to.
            */}
            <input type="hidden" name="brand" value={brand.id} />
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

        {/*
          WHAT CHANGED — shown only when something did. The four numbers a
          reader needs to disagree with the finding (observed, baseline, how many
          periods the baseline spans, and the deviation against the configured
          threshold) are all printed; "engagement dropped" with no baseline is a
          claim, not a finding (anomalies.ts).
        */}
        {data.shift ? (
          <Card testId="analytics-shift">
            <SectionHeader
              title={t('analytics.shift.title')}
              actions={
                <StatusBadge
                  tone={data.shift.direction === 'above' ? 'success' : 'warning'}
                  label={t(`analytics.shift.${data.shift.direction}` as MessageKey)}
                />
              }
            />
            <p style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textPrimary }}>
              {t('analytics.shift.body')
                .replace('{metric}', t(`analytics.metric.${data.shift.metricKey}` as MessageKey))
                .replace('{day}', day.format(data.shift.periodStart))
                .replace('{observed}', number.format(Number(data.shift.observedValue)))
                .replace('{baseline}', number.format(Number(data.shift.baselineValue)))
                .replace('{periods}', number.format(data.shift.baselinePeriods))
                .replace('{deviation}', percent.format(data.shift.deviationMilli / 1_000))
                .replace('{threshold}', percent.format(data.shift.thresholdMilli / 1_000))}
            </p>
          </Card>
        ) : null}

        {/*
          WHAT NEXT — each step derived from a condition measured above and
          gated on the permission of the screen it links to. Absent when there is
          nothing to do: no "all good!" filler.
        */}
        {nextSteps.length > 0 ? (
          <Card testId="analytics-next">
            <SectionHeader
              title={t('analytics.next.title')}
              actions={
                workspace.permissionKeys.includes('copilot.use') ? (
                  <Link
                    href={copilotHref(locale, 'analytics')}
                    style={buttonStyle('ghost', 'sm')}
                    className={buttonClass('ghost')}
                    data-testid="analytics-ask-copilot"
                  >
                    {t('copilot.ask')}
                  </Link>
                ) : undefined
              }
            />
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: spacingTokens.sm,
              }}
            >
              {nextSteps.map((step) => (
                <li
                  key={step.key}
                  data-testid={`analytics-next-${step.key}`}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: spacingTokens.sm,
                    ...typographyTokens.bodySm,
                  }}
                >
                  <span style={{ color: colorTokens.textPrimary }}>
                    {t(`analytics.next.${step.key}` as MessageKey)}
                  </span>
                  {step.href ? (
                    <Link
                      href={`/${locale}${step.href}`}
                      style={buttonStyle('ghost', 'sm')}
                      className={buttonClass('ghost')}
                    >
                      {t(`analytics.next.${step.key}.action` as MessageKey)}
                    </Link>
                  ) : step.key === 'explain-shift' ? (
                    <ExplainForm
                      locale={locale}
                      brandId={brand.id}
                      days={days}
                      compare={compare}
                      label={t('analytics.explain')}
                      testId="analytics-explain-shift"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

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
            <SectionHeader
              title={t('insights.title')}
              actions={
                mayExplain ? (
                  <ExplainForm
                    locale={locale}
                    brandId={brand.id}
                    days={days}
                    compare={compare}
                    label={t('analytics.explain')}
                    testId="analytics-explain"
                  />
                ) : undefined
              }
            />
            <p style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
              {t('insights.noExternalData')}
            </p>
            {mayExplain ? (
              <p style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textMuted }}>
                {t('analytics.explainHint')}
              </p>
            ) : null}
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
                    {/*
                      TO MARKETING INTELLIGENCE, which is where an explanation,
                      an anomaly or a recommendation is read in full with its
                      evidence. It pointed at `/strategy` while that screen
                      listed every insight; since Phase 8 that screen carries
                      plans and this one's findings belong next door.
                    */}
                    <Link href={`/${locale}/intelligence?insight=${insight.id}`}>
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
}: {
  locale: string;
  brandId: string;
  days: number;
  compare: boolean;
  label: string;
  testId: string;
}) {
  return (
    <form action={explainPeriodAction}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="brandId" value={brandId} />
      <input type="hidden" name="range" value={String(days)} />
      <input type="hidden" name="compare" value={compare ? '1' : '0'} />
      <button
        type="submit"
        style={buttonStyle('brand', 'sm')}
        className={buttonClass('brand')}
        data-testid={testId}
      >
        {label}
      </button>
    </form>
  );
}
