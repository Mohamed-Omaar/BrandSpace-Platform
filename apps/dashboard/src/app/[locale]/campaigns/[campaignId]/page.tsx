import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AssetThumb,
  Card,
  LinkTabs,
  MetricCard,
  SectionHeader,
  StateMessage,
  StatusBadge,
  buttonStyle,
  colorTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
} from '@brandspace/ui';
import { isAppError, systemClock } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../../server/customer-context';
import { mediaForVariants } from '../../../../server/media-picker';
import { activityTimeline } from '../../../../server/activity-timeline';
import { ActivityTimeline } from '../../../../components/activity-timeline';
import { EmptyAction } from '../../../../components/empty-action';
import { messages, type MessageKey } from '../../../../i18n/messages';
import { brandContextFor } from '../../../../server/brand-context';
import { inContentStudio } from '../../../../server/content-context';
import { inAnalytics } from '../../../../server/analytics-context';
import { statusMessage, translator } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { NotesPanel } from '../../../../components/notes-panel';
import { archiveCampaignAction, updateCampaignAction } from '../actions';
import { CampaignFormView } from '../campaign-form-view';
import {
  contentStatusLabel,
  dateInputValue,
  formLabels,
  objectiveLabel,
  periodLabel,
  statusLabel,
} from '../labels';
import { briefFrom } from '../../../../server/campaign-form';

export const dynamic = 'force-dynamic';

/**
 * ONE CAMPAIGN: its details, its content, and its performance (AC-26.2 … 26.4).
 *
 * THE CAMPAIGN'S OWN BRAND DECIDES, NOT THE RAIL (D-190). An existing object
 * belongs to the brand stored on it, and global context never reinterprets
 * that — so this page reads `campaign.brandId` and passes it to the analytics
 * scope rather than asking the selector which brand the reader is "on".
 *
 * PERFORMANCE IS THE EXISTING ANALYTICS STACK, NARROWED. `AnalyticsScope`
 * already carries `campaignId` and `MetricObservation` already joins through
 * `content_item.campaignId`, so this is one `summary()` call with a scope —
 * not a second analytics implementation, which is what the phase brief rules
 * out and what a campaign-specific aggregation would have become.
 *
 * FOUR HEADLINE FIGURES, and a missing one reads as missing. `MetricValue.value`
 * is null for "no observation", which is not zero, and the card says so.
 */
const HEADLINE_METRICS = ['impressions', 'reach', 'engagements', 'engagement_rate'] as const;
const WINDOW_DAYS = 30;

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; campaignId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, campaignId } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'campaigns.read');

  const single = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const brandContext = await brandContextFor(workspace, '/campaigns');
  const mayManage = workspace.permissionKeys.includes('campaigns.manage');

  /*
   * A CAMPAIGN OUTSIDE THE MEMBER'S SCOPE IS INDISTINGUISHABLE FROM ONE THAT
   * DOES NOT EXIST (CLAUDE.md §2.1). The service puts the scope in the WHERE
   * and throws NOT_FOUND; this turns that into the framework's own 404 so the
   * response is shaped exactly like a route that was never there.
   */
  const data = await inContentStudio(workspace.workspaceId, async (services) => {
    const campaigns = services.campaigns();
    try {
      const campaign = await campaigns.get(campaignId, workspace.brandScope);
      const policy = await services.policy();
      const library = await services.library();
      const items = await library.listItems({
        brandId: campaign.brandId,
        brandScope: workspace.brandScope,
        campaignId: campaign.id,
        limit: 100,
      });
      return { campaign, platforms: policy.platforms, items };
    } catch (error: unknown) {
      if (isAppError(error) && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  });

  if (!data) notFound();
  const { campaign, platforms, items } = data;

  /*
   * PHASE 6 FINAL (D-277 §14, D-289) — THE PROJECT ROOM.
   *
   * Tabs are addresses (`?tab=`), so a link can open the room on its content
   * or its performance. Every figure below is read from the existing domain:
   * items and their statuses, calendar slots, note threads, the one Asset
   * Library, the analytics stack narrowed to this campaign, the insights
   * linked to it, and the audit trail. Nothing is invented and nothing new is
   * stored.
   */
  const TABS = ['overview', 'content', 'calendar', 'assets', 'performance', 'activity'] as const;
  type Tab = (typeof TABS)[number];
  const tab: Tab = (TABS as readonly string[]).includes(single('tab') ?? '')
    ? (single('tab') as Tab)
    : 'overview';
  const tabHref = (next: Tab, extra: Record<string, string> = {}) =>
    `/${locale}/campaigns/${campaign.id}?${new URLSearchParams({ tab: next, ...extra }).toString()}`;
  const now = systemClock.now();
  const itemIds = items.map((item) => item.id);

  const room = await inWorkspace(workspace.workspaceId, async ({ db }) => {
    const ownerId = campaign.ownerUserId ?? campaign.createdByUserId;
    const [owner, slots, threads, insights] = await Promise.all([
      ownerId
        ? db.membership.findFirst({
            where: { userId: ownerId },
            select: { user: { select: { name: true, email: true } } },
          })
        : Promise.resolve(null),
      itemIds.length === 0
        ? Promise.resolve([])
        : db.calendarSlot.findMany({
            where: { contentItemId: { in: itemIds }, status: { not: 'CANCELLED' } },
            orderBy: { scheduledAtUtc: 'asc' },
            select: {
              id: true,
              contentItemId: true,
              scheduledAtUtc: true,
              status: true,
              platformKeys: true,
            },
            take: 200,
          }),
      itemIds.length === 0
        ? Promise.resolve([])
        : db.noteThread.groupBy({
            by: ['contentItemId'],
            where: { contentItemId: { in: itemIds }, status: 'OPEN' },
            _count: { _all: true },
          }),
      workspace.permissionKeys.includes('strategy.read') ||
      workspace.permissionKeys.includes('analytics.read')
        ? db.insight.findMany({
            where: {
              campaignId: campaign.id,
              status: { in: ['NEW', 'SEEN'] },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            orderBy: { createdAt: 'desc' },
            select: { id: true, title: true, type: true },
            take: 5,
          })
        : Promise.resolve([]),
    ]);
    return {
      owner: owner ? (owner.user.name ?? owner.user.email) : null,
      slots,
      openNotes: new Map(threads.map((row) => [row.contentItemId ?? '', row._count._all] as const)),
      insights,
    };
  });

  /* THE ONE ASSET LIBRARY: first picture per post, and every file the posts use. */
  const usedAssetIds = [
    ...new Set(
      items.flatMap((item) =>
        item.variants.flatMap((variant) => [
          ...variant.assetIds,
          ...(variant.coverAssetId ? [variant.coverAssetId] : []),
        ]),
      ),
    ),
  ];
  const media = await mediaForVariants({
    workspaceId: workspace.workspaceId,
    userId: customer.userId,
    permissionKeys: workspace.permissionKeys,
    brandScope: workspace.brandScope,
    assetIds: tab === 'assets' || tab === 'content' ? usedAssetIds : [],
  });

  /*
   * PERFORMANCE IS BEST-EFFORT AND SAYS SO. A workspace with no connected
   * account has no analytics policy to resolve and no observations to read;
   * that is an empty state, not an error, and it must not take the whole page
   * down with it. The previous 30 days are the comparison: "what changed".
   */
  const analyticsAllowed = workspace.permissionKeys.includes('analytics.read');
  const performance = analyticsAllowed
    ? await inAnalytics(workspace.workspaceId, async (services) => {
        try {
          const queries = await services.queries();
          const period = { start: new Date(now.getTime() - WINDOW_DAYS * 86_400_000), end: now };
          const comparison = {
            start: new Date(now.getTime() - 2 * WINDOW_DAYS * 86_400_000),
            end: period.start,
          };
          const scope = { brandId: campaign.brandId, campaignId: campaign.id };
          const [summary, top] = await Promise.all([
            queries.summary({
              scope,
              period,
              comparison,
              brandScope: workspace.brandScope,
              metricKeys: HEADLINE_METRICS,
            }),
            tab === 'performance'
              ? queries.topPosts({
                  scope,
                  period,
                  metricKey: 'engagements',
                  limit: 5,
                  brandScope: workspace.brandScope,
                })
              : Promise.resolve([]),
          ]);
          return { summary, top };
        } catch {
          return null;
        }
      })
    : null;

  /* D-298 — the shared contextual timeline: the campaign and its posts. */
  const activity =
    tab === 'activity' || tab === 'overview'
      ? await activityTimeline({
          locale,
          workspace,
          userId: customer.userId,
          resourceIds: [campaign.id, ...itemIds],
          take: tab === 'activity' ? 50 : 5,
        })
      : [];

  const brief = briefFrom(campaign.brief);
  const dictionary = (locale === 'ar' ? messages.ar : messages.en) as Readonly<
    Record<string, string | undefined>
  >;
  const numberFormat = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en', {
    numberingSystem: 'latn',
  });
  const dateFormat = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const byStatus = (status: string) => items.filter((item) => item.status === status).length;
  const published = byStatus('PUBLISHED') + byStatus('PARTIALLY_PUBLISHED');
  const waiting = byStatus('IN_REVIEW');
  const nextSlot = room.slots.find(
    (slot) => slot.scheduledAtUtc.getTime() > now.getTime() && slot.status !== 'PUBLISHED',
  );
  const titleOf = (itemId: string) => items.find((item) => item.id === itemId)?.title ?? '—';
  const pick = (value: unknown) => {
    const text = value as { en?: string; ar?: string } | null;
    return (locale === 'ar' ? (text?.ar ?? text?.en) : (text?.en ?? text?.ar)) ?? '';
  };

  const CONTENT_FILTERS = [
    'DRAFT',
    'CHANGES_REQUESTED',
    'IN_REVIEW',
    'APPROVED',
    'SCHEDULED',
    'PUBLISHED',
  ] as const;
  const statusFilter = (CONTENT_FILTERS as readonly string[]).includes(single('status') ?? '')
    ? (single('status') as string)
    : null;
  const shownItems = statusFilter ? items.filter((item) => item.status === statusFilter) : items;

  const metricsBlock =
    performance && performance.summary.metrics.some((metric) => metric.value !== null) ? (
      <>
        {performance.summary.containsMockData ? (
          <p
            style={{
              ...typographyTokens.bodySm,
              color: colorTokens.textMuted,
              marginBlockStart: 0,
            }}
            data-testid="campaign-sample-notice"
          >
            {t('campaigns.performanceSample')}
          </p>
        ) : null}
        <div
          style={{
            display: 'grid',
            gap: spacingTokens.md,
            gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
          }}
          data-testid="campaign-metrics"
        >
          {performance.summary.metrics.map((metric) => (
            <MetricCard
              key={metric.metricKey}
              label={dictionary[`campaigns.metric.${metric.metricKey}`] ?? metric.metricKey}
              value={metric.value === null ? '—' : numberFormat.format(Number(metric.value))}
              testId={`campaign-metric-${metric.metricKey}`}
            />
          ))}
        </div>
      </>
    ) : (
      <StateMessage
        kind="empty"
        title={t('campaigns.performance')}
        description={t('campaigns.performanceEmpty')}
        testId="campaign-performance-empty"
      />
    );

  const writePost = (
    <Link
      href={`/${locale}/content/compose?campaign=${campaign.id}`}
      style={buttonStyle('brand')}
      data-testid="campaign-write-post"
    >
      {t('campaigns.contentEmptyAction')}
    </Link>
  );

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={campaign.name}
      description={objectiveLabel(t, campaign.objective)}
      activePath="/campaigns"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
      actions={
        <Link
          href={`/${locale}/campaigns`}
          style={buttonStyle('neutral')}
          data-testid="campaign-back"
        >
          {t('campaigns.back')}
        </Link>
      }
    >
      {single('error') && (
        <CustomerBanner tone="error">
          {statusMessage(single('error'), locale, single('ref'))}
        </CustomerBanner>
      )}
      {single('ok') && statusMessage(single('ok'), locale) && (
        <CustomerBanner tone="success">{statusMessage(single('ok'), locale)}</CustomerBanner>
      )}

      <div style={{ display: 'grid', gap: spacingTokens.lg }}>
        {/* ------------------------------------------------ the header --- */}
        <Card testId="campaign-summary">
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: spacingTokens.md,
              alignItems: 'center',
            }}
          >
            <StatusBadge
              tone={statusTone(campaign.status)}
              label={statusLabel(t, campaign.status)}
              testId="campaign-status"
            />
            <span style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
              {t('campaigns.room.goal')}: {objectiveLabel(t, campaign.objective)}
            </span>
            <span style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
              {periodLabel(campaign.startDate, campaign.endDate, locale, t('campaigns.noDates'))}
            </span>
            <span
              style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
              data-testid="campaign-channels-summary"
            >
              {campaign.channels.length === 0
                ? t('campaigns.noChannels')
                : campaign.channels.join(' · ')}
            </span>
            {room.owner ? (
              <span
                style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
                data-testid="campaign-owner"
              >
                {t('campaigns.room.owner')}: {room.owner}
              </span>
            ) : null}
          </div>
          {brief.en !== '' || brief.ar !== '' ? (
            <p
              style={{ ...typographyTokens.body, color: colorTokens.textPrimary, marginBlock: 0 }}
              data-testid="campaign-brief"
              dir={locale === 'ar' ? 'rtl' : 'ltr'}
            >
              {locale === 'ar' ? brief.ar || brief.en : brief.en || brief.ar}
            </p>
          ) : null}
        </Card>

        <LinkTabs
          label={t('campaigns.room.tabs')}
          testId="campaign-tabs"
          currentId={tab}
          tabs={TABS.map((id) => ({
            id,
            href: tabHref(id),
            label: t(`campaigns.room.tab.${id}` as MessageKey),
            ...(id === 'content' ? { badge: numberFormat.format(items.length) } : {}),
          }))}
        />

        {/* ------------------------------------------------- overview --- */}
        {tab === 'overview' ? (
          <>
            <div
              style={{
                display: 'grid',
                gap: spacingTokens.md,
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(15rem, 100%), 1fr))',
              }}
            >
              <Card title={t('campaigns.room.progress')} testId="campaign-progress">
                <p style={{ margin: 0, ...typographyTokens.body }}>
                  {t('campaigns.room.publishedOf')
                    .replace('{published}', numberFormat.format(published))
                    .replace('{total}', numberFormat.format(items.length))}
                </p>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: spacingTokens['3xs'],
                    marginBlockStart: spacingTokens.xs,
                  }}
                >
                  {(['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED'] as const)
                    .filter((status) => byStatus(status) > 0)
                    .map((status) => (
                      <StatusBadge
                        key={status}
                        tone={statusTone(status)}
                        label={`${contentStatusLabel(t, status)} · ${numberFormat.format(byStatus(status))}`}
                      />
                    ))}
                </div>
              </Card>
              <Card title={t('campaigns.room.waiting')} testId="campaign-waiting">
                <p style={{ margin: 0, ...typographyTokens.body }}>
                  {waiting === 0
                    ? t('campaigns.room.waitingNone')
                    : t('campaigns.room.waitingSome').replace(
                        '{count}',
                        numberFormat.format(waiting),
                      )}
                </p>
                {waiting > 0 ? (
                  <Link
                    href={tabHref('content', { status: 'IN_REVIEW' })}
                    style={{ ...typographyTokens.label, color: colorTokens.brandPurple }}
                  >
                    {t('campaigns.room.open')}
                  </Link>
                ) : null}
              </Card>
              <Card title={t('campaigns.room.next')} testId="campaign-next">
                {nextSlot ? (
                  <p style={{ margin: 0, ...typographyTokens.body }}>
                    <Link
                      href={`/${locale}/content/compose?item=${nextSlot.contentItemId}`}
                      style={{ color: colorTokens.brandPurple, fontWeight: 600 }}
                    >
                      {titleOf(nextSlot.contentItemId)}
                    </Link>{' '}
                    · {dateFormat.format(nextSlot.scheduledAtUtc)} UTC
                  </p>
                ) : (
                  <p
                    style={{
                      margin: 0,
                      ...typographyTokens.body,
                      color: colorTokens.textSecondary,
                    }}
                  >
                    {t('campaigns.room.nextNone')}
                  </p>
                )}
              </Card>
            </div>

            <section>
              <SectionHeader title={t('campaigns.performance')} />
              {metricsBlock}
            </section>

            {items.length === 0 ? (
              <StateMessage
                kind="empty"
                title={t('campaigns.contentTitle')}
                description={t('campaigns.contentEmpty')}
                testId="campaign-content-empty"
                action={writePost}
              />
            ) : null}

            {activity.length > 0 ? (
              <Card title={t('campaigns.room.recentActivity')} testId="campaign-recent-activity">
                <ActivityTimeline entries={activity} />
              </Card>
            ) : null}

            {/*
              THE CONVERSATION LIVES IN THE ROOM (P6-05) — contextual, never a
              tab of its own. The panel renders nothing for a member who may
              not read this campaign's notes.
            */}
            <NotesPanel
              locale={locale}
              subject={{ type: 'CAMPAIGN', campaignId: campaign.id }}
              returnPath={`/${locale}/campaigns/${campaign.id}`}
              highlightThreadId={typeof query['thread'] === 'string' ? query['thread'] : null}
            />

            {mayManage ? (
              <details data-testid="campaign-details">
                <summary style={{ ...typographyTokens.label, cursor: 'pointer' }}>
                  {t('campaigns.detailsTitle')}
                </summary>
                <div style={{ marginBlockStart: spacingTokens.md }}>
                  <CampaignFormView
                    action={updateCampaignAction}
                    hidden={{
                      locale,
                      campaignId: campaign.id,
                      version: String(campaign.version),
                    }}
                    values={{
                      name: campaign.name,
                      objective: campaign.objective,
                      briefAr: brief.ar,
                      briefEn: brief.en,
                      description: campaign.description ?? '',
                      startDate: dateInputValue(campaign.startDate),
                      endDate: dateInputValue(campaign.endDate),
                      channels: campaign.channels,
                      status: campaign.status === 'ARCHIVED' ? 'DRAFT' : campaign.status,
                    }}
                    labels={formLabels(t, t('campaigns.save'))}
                    platforms={platforms.map((platform) => ({
                      key: platform.key,
                      label: platform.key,
                    }))}
                    withStatus
                    testId="campaign-edit-form"
                  />
                  {/*
                    ARCHIVE IS ITS OWN FORM AND ITS OWN ACTION: a soft delete
                    with its own audit event, not a value in the dropdown.
                  */}
                  {campaign.status !== 'ARCHIVED' ? (
                    <form
                      action={archiveCampaignAction}
                      style={{ marginBlockStart: spacingTokens.md }}
                      data-testid="campaign-archive-form"
                    >
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="campaignId" value={campaign.id} />
                      <p
                        style={{
                          ...typographyTokens.bodySm,
                          color: colorTokens.textMuted,
                          marginBlockEnd: spacingTokens.xs,
                        }}
                      >
                        {t('campaigns.archiveHint')}
                      </p>
                      <button
                        type="submit"
                        style={buttonStyle('neutral')}
                        data-testid="campaign-archive"
                      >
                        {t('campaigns.archive')}
                      </button>
                    </form>
                  ) : null}
                </div>
              </details>
            ) : null}
          </>
        ) : null}

        {/* -------------------------------------------------- content --- */}
        {tab === 'content' ? (
          <section style={{ display: 'grid', gap: spacingTokens.md }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: spacingTokens.sm,
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <LinkTabs
                label={t('campaigns.room.contentFilter')}
                testId="campaign-content-filter"
                currentId={statusFilter ?? 'all'}
                tabs={[
                  { id: 'all', href: tabHref('content'), label: t('campaigns.room.all') },
                  ...CONTENT_FILTERS.filter((status) => byStatus(status) > 0).map((status) => ({
                    id: status,
                    href: tabHref('content', { status }),
                    label: contentStatusLabel(t, status),
                    badge: numberFormat.format(byStatus(status)),
                  })),
                ]}
              />
              {writePost}
            </div>
            {shownItems.length === 0 ? (
              <StateMessage
                kind="empty"
                title={t('campaigns.contentTitle')}
                description={t('campaigns.contentEmpty')}
                testId="campaign-content-empty"
              />
            ) : (
              <Card testId="campaign-content">
                <ul style={listStyle}>
                  {shownItems.map((item) => {
                    const first = item.variants
                      .flatMap((variant) => variant.assetIds)
                      .map((id) => media.get(id))
                      .find((option) => option !== undefined);
                    const notes = room.openNotes.get(item.id) ?? 0;
                    return (
                      <li
                        key={item.id}
                        style={rowStyle}
                        data-testid={`campaign-content-${item.id}`}
                      >
                        {first?.previewToken ? (
                          <AssetThumb
                            src={`/${locale}/assets/file/${first.previewToken}`}
                            alt=""
                            size="3rem"
                          />
                        ) : (
                          <span aria-hidden="true" style={thumbPlaceholder} />
                        )}
                        <span
                          style={{ display: 'grid', gap: spacingTokens['3xs'], flex: '1 1 14rem' }}
                        >
                          <Link
                            href={`/${locale}/content/compose?item=${item.id}`}
                            style={{ color: colorTokens.brandPurple, fontWeight: 600 }}
                          >
                            {item.title}
                          </Link>
                          <span
                            style={{
                              ...typographyTokens.caption,
                              color: colorTokens.textSecondary,
                            }}
                          >
                            {[
                              dictionary[`content.type.${item.contentType}`] ?? item.contentType,
                              [
                                ...new Set(item.variants.map((variant) => variant.platformKey)),
                              ].join(', '),
                              dictionary[`content.language.${item.primaryLocale}`] ??
                                item.primaryLocale,
                              notes > 0
                                ? t('campaigns.room.notes').replace(
                                    '{count}',
                                    numberFormat.format(notes),
                                  )
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                        <StatusBadge
                          tone={statusTone(item.status)}
                          label={contentStatusLabel(t, item.status)}
                        />
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </section>
        ) : null}

        {/* ------------------------------------------------- calendar --- */}
        {tab === 'calendar' ? (
          <Card
            title={t('campaigns.room.tab.calendar')}
            description={t('campaigns.room.calendarBody')}
            testId="campaign-calendar"
          >
            {room.slots.length === 0 ? (
              <StateMessage
                kind="empty"
                title={t('campaigns.room.calendarEmpty')}
                description={t('campaigns.room.calendarEmptyBody')}
              />
            ) : (
              <ol style={listStyle}>
                {room.slots.map((slot) => (
                  <li key={slot.id} style={rowStyle} data-testid={`campaign-slot-${slot.id}`}>
                    <time
                      dateTime={slot.scheduledAtUtc.toISOString()}
                      style={{ ...typographyTokens.label, minInlineSize: '10rem' }}
                    >
                      {dateFormat.format(slot.scheduledAtUtc)} UTC
                    </time>
                    <Link
                      href={`/${locale}/content/compose?item=${slot.contentItemId}`}
                      style={{ color: colorTokens.brandPurple, fontWeight: 600, flex: '1 1 12rem' }}
                    >
                      {titleOf(slot.contentItemId)}
                    </Link>
                    <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                      {slot.platformKeys.join(', ')}
                    </span>
                    <StatusBadge
                      tone={statusTone(slot.status)}
                      label={contentStatusLabel(t, slot.status)}
                    />
                  </li>
                ))}
              </ol>
            )}
            <Link
              href={`/${locale}/calendar?campaign=${campaign.id}`}
              style={{ ...buttonStyle('neutral'), marginBlockStart: spacingTokens.sm }}
              data-testid="campaign-open-calendar"
            >
              {t('campaigns.room.openCalendar')}
            </Link>
          </Card>
        ) : null}

        {/* --------------------------------------------------- assets --- */}
        {tab === 'assets' ? (
          <Card
            title={t('campaigns.room.tab.assets')}
            description={t('campaigns.room.assetsBody')}
            testId="campaign-assets"
          >
            {media.size === 0 ? (
              <StateMessage
                kind="empty"
                title={t('campaigns.room.assetsEmpty')}
                description={t('campaigns.room.assetsEmptyBody')}
                action={
                  <EmptyAction
                    href={tabHref('content')}
                    label={t('campaigns.room.assetsEmptyAction')}
                    testId="campaign-assets-empty-action"
                    tone="neutral"
                  />
                }
              />
            ) : (
              <ul
                style={{
                  ...listStyle,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(7rem, 1fr))',
                }}
              >
                {[...media.values()].map((asset) => (
                  <li key={asset.id} data-testid={`campaign-asset-${asset.id}`}>
                    <Link
                      href={`/${locale}/assets?asset=${asset.id}`}
                      style={{
                        display: 'grid',
                        gap: spacingTokens['3xs'],
                        justifyItems: 'center',
                        textDecoration: 'none',
                        color: colorTokens.textSecondary,
                        ...typographyTokens.caption,
                      }}
                    >
                      {asset.previewToken ? (
                        <AssetThumb
                          src={`/${locale}/assets/file/${asset.previewToken}`}
                          alt=""
                          size="5rem"
                        />
                      ) : (
                        <span aria-hidden="true" style={thumbPlaceholder} />
                      )}
                      <span style={{ overflowWrap: 'anywhere' }}>{asset.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}

        {/* ---------------------------------------------- performance --- */}
        {tab === 'performance' ? (
          <section style={{ display: 'grid', gap: spacingTokens.md }}>
            {!analyticsAllowed ? (
              <StateMessage
                kind="empty"
                title={t('campaigns.performance')}
                description={t('campaigns.performanceEmpty')}
                testId="campaign-performance-empty"
              />
            ) : (
              <>
                <Card title={t('campaigns.room.whatChanged')} testId="campaign-what-changed">
                  {performance &&
                  performance.summary.metrics.some((metric) => metric.changeMilli !== null) ? (
                    <ul style={listStyle}>
                      {performance.summary.metrics
                        .filter((metric) => metric.changeMilli !== null)
                        .map((metric) => (
                          <li key={metric.metricKey} style={rowStyle}>
                            <span style={{ flex: '1 1 12rem' }}>
                              {dictionary[`campaigns.metric.${metric.metricKey}`] ??
                                metric.metricKey}
                            </span>
                            <strong>{(Number(metric.changeMilli) / 10).toFixed(1)}%</strong>
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p
                      style={{
                        margin: 0,
                        ...typographyTokens.bodySm,
                        color: colorTokens.textSecondary,
                      }}
                    >
                      {t('campaigns.room.whatChangedNone')}
                    </p>
                  )}
                </Card>
                <Card title={t('campaigns.room.whatContributed')} testId="campaign-contributed">
                  {performance && performance.top.length > 0 ? (
                    <ol style={listStyle}>
                      {performance.top.map((post) => (
                        <li key={`${post.contentItemId}-${post.provider}`} style={rowStyle}>
                          <Link
                            href={`/${locale}/content/compose?item=${post.contentItemId}`}
                            style={{
                              color: colorTokens.brandPurple,
                              fontWeight: 600,
                              flex: '1 1 12rem',
                            }}
                          >
                            {post.title ?? '—'}
                          </Link>
                          <span
                            style={{
                              ...typographyTokens.caption,
                              color: colorTokens.textSecondary,
                            }}
                          >
                            {t('campaigns.room.engagements').replace(
                              '{count}',
                              numberFormat.format(Number(post.value)),
                            )}
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p
                      style={{
                        margin: 0,
                        ...typographyTokens.bodySm,
                        color: colorTokens.textSecondary,
                      }}
                    >
                      {t('campaigns.room.whatContributedNone')}
                    </p>
                  )}
                </Card>
                <Card title={t('campaigns.room.whatToTry')} testId="campaign-what-to-try">
                  {room.insights.length > 0 ? (
                    <ul style={listStyle}>
                      {room.insights.map((insight) => (
                        <li key={insight.id} style={rowStyle}>
                          <span style={{ flex: '1 1 12rem' }}>{pick(insight.title)}</span>
                          <Link
                            href={`/${locale}/intelligence?insight=${insight.id}`}
                            style={{ ...typographyTokens.label, color: colorTokens.brandPurple }}
                          >
                            {t('home.recommended.giveToCopilot')}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p
                      style={{
                        margin: 0,
                        ...typographyTokens.bodySm,
                        color: colorTokens.textSecondary,
                      }}
                    >
                      {t('campaigns.room.whatToTryNone')}
                    </p>
                  )}
                </Card>
                <section>
                  <SectionHeader title={t('campaigns.performance')} />
                  {metricsBlock}
                </section>
              </>
            )}
          </section>
        ) : null}

        {/* ------------------------------------------------- activity --- */}
        {tab === 'activity' ? (
          <Card title={t('campaigns.room.tab.activity')} testId="campaign-activity">
            {activity.length === 0 ? (
              <StateMessage
                kind="empty"
                title={t('activity.emptyTitle')}
                description={t('campaigns.room.activityEmptyBody')}
              />
            ) : (
              <ActivityTimeline entries={activity} />
            )}
          </Card>
        ) : null}
      </div>
    </WorkspaceShell>
  );
}

const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gap: spacingTokens.sm,
} as const;

const rowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: spacingTokens.sm,
  alignItems: 'center',
} as const;

const thumbPlaceholder = {
  display: 'inline-block',
  inlineSize: '3rem',
  blockSize: '3rem',
  borderRadius: '0.5rem',
  background: colorTokens.surfaceMuted,
} as const;
