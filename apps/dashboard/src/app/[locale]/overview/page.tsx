import Link from 'next/link';
import {
  Card,
  ContentGrid,
  MetricCard,
  HeroFloatCard,
  HeroMiniChart,
  OverviewHero,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonStyle,
  colorTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
} from '@brandspace/ui';
import { brandIdScopeFilter, systemClock } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor } from '../../../server/brand-context';
import { inContentStudio } from '../../../server/content-context';
import { inAnalytics } from '../../../server/analytics-context';
import { activityService, notificationService } from '../../../server/approvals-context';
import { attentionItems, type AttentionItem } from '../../../server/command-center';
import { translator } from '../../../i18n/messages';
import { WorkspaceShell } from '../../../components/workspace-shell';

export const dynamic = 'force-dynamic';

/**
 * The sentence for one attention item, in the reader's language.
 *
 * WHY A FUNCTION AND NOT A TEMPLATE AT THE CALL SITE. Two of the items need a
 * different sentence for one versus many — "Northwind has no brand knowledge
 * yet" is actionable in a way "1 brand" is not — and that choice belongs beside
 * the strings rather than inside the JSX.
 *
 * `{count}` and `{detail}` are substituted rather than concatenated, so Arabic
 * can put the number where Arabic puts it (CLAUDE.md §4).
 */
function attentionSentence(t: (key: never) => string, item: AttentionItem): string {
  const key =
    item.detail === undefined && item.kind === 'brand-brain-empty'
      ? 'attention.brand-brain-empty.many'
      : `attention.${item.kind}`;
  return t(key as never)
    .replace('{count}', String(item.count))
    .replace('{detail}', item.detail ?? '');
}

/**
 * The authenticated workspace home, and the screen the approved direction is
 * judged on (§5 of the brief).
 *
 * THE LARGE OVERVIEW IS REPRODUCED, THE INVENTED DATA IS NOT. The reference's
 * hero, its four-across statistic row, its 1.45/0.8 split and its section
 * kickers are all here at the reference's scale. What is not here is the
 * reference's content: "12 scheduled", "03 in review", "28 published across 4
 * channels", "76% of AI credits, resets in 12 days", and two posts on a
 * calendar. There is no Post model, no connected account and no publishing
 * pipeline in this phase, so every one of those would be a fabricated
 * measurement — CLAUDE.md §2.2, and the reason this page has always shown
 * either a real figure or an explicit reason it is unavailable.
 *
 * So each panel says which of the three things is true: here is the real
 * number; you do not have permission to see it; or the capability has not
 * shipped yet. An empty state that names its reason is a finished screen. A
 * plausible-looking zero is not.
 */
export default async function OverviewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale);

  const maySeeBilling = workspace.permissionKeys.includes('billing.read');
  const maySeeCredits = workspace.permissionKeys.includes('credits.read');
  const maySeeMembers = workspace.permissionKeys.includes('member.read');

  const maySeeContent = workspace.permissionKeys.includes('content.read');
  const maySeeAnalytics = workspace.permissionKeys.includes('analytics.read');

  const { effective, wallet, memberCount } = await inWorkspace(
    workspace.workspaceId,
    async ({ entitlements, credits, db }) => ({
      effective: maySeeBilling ? await entitlements.resolveAll(workspace.workspaceId) : null,
      wallet: maySeeCredits ? await credits.wallet(workspace.workspaceId) : null,
      memberCount: maySeeMembers
        ? await db.membership.count({
            where: { workspaceId: workspace.workspaceId, status: 'ACTIVE' },
          })
        : null,
    }),
  );

  /*
   * PHASE 5B-3 — THE COMMAND CENTER AGGREGATES; IT DOES NOT DUPLICATE.
   *
   * Every figure below is read through the module that owns it — the approvals
   * queue from `ContentApprovalService`, upcoming slots from the calendar's own
   * table, recent activity from `ActivityLogService`, the unread badge from
   * `NotificationService` — so the home screen and the module screens cannot
   * disagree. A dashboard that counted rows itself would be a second
   * implementation of four different scoping rules, and the activity one is
   * graded three ways.
   *
   * WHAT IS STILL NOT HERE, and for the same reason it never was: published
   * counts and engagement need the publishing pipeline (Phase 6) and analytics
   * ingestion (Phase 7). Those panels keep saying so.
   */
  /*
   * PHASE 7 — THE ENGAGEMENT FIGURE THE COMMAND CENTER COULD NOT MEASURE BEFORE.
   *
   * READ THROUGH THE MODULE THAT OWNS IT, exactly as every other figure on this
   * screen is: `AnalyticsQueryService` applies BrandScope as a query predicate
   * and tells missing from zero, so the home screen and the analytics screen
   * cannot disagree. A dashboard that summed `metric_observation` itself would
   * be a second implementation of both rules.
   *
   * ONLY WHEN THE READER MAY SEE IT. A total fetched and then dropped in
   * JavaScript is a disclosure computed over rows this person may not see (F-10).
   */
  const engagements = maySeeAnalytics
    ? await inAnalytics(workspace.workspaceId, async (services) => {
        const queries = await services.queries();
        const now = systemClock.now();
        const result = await queries.summary({
          scope: {},
          period: { start: new Date(now.getTime() - 28 * 86_400_000), end: now },
          brandScope: workspace.brandScope,
          metricKeys: ['engagements'],
        });
        const metric = result.metrics.find((entry) => entry.metricKey === 'engagements');
        return metric?.value === null || metric?.value === undefined ? null : Number(metric.value);
      })
    : null;

  const summary = await inWorkspace(workspace.workspaceId, async (scoped) => {
    const notifications = notificationService({
      db: scoped.db,
      workspaceId: workspace.workspaceId,
    });
    const activity = activityService({ db: scoped.db, workspaceId: workspace.workspaceId });
    const viewer = {
      userId: customer.userId,
      permissionKeys: workspace.permissionKeys,
      brandScope: workspace.brandScope,
    };
    const recent = await activity.recent({ viewer, take: 6 });
    const unread = await notifications.unreadCount(customer.userId);

    if (!maySeeContent) {
      return { recent, unread, pendingApprovals: 0, inReview: 0, upcoming: [], scope: 'none' };
    }

    /*
     * `brandIdScopeFilter` IS THE RULE, applied once. An empty membership scope
     * is UNRESTRICTED, so it contributes no clause — this page used to expand
     * it into "every brand id" to work around a service that read empty as
     * "none", which was the rule implemented a second time in a page.
     */
    const upcoming = await scoped.db.calendarSlot.findMany({
      where: {
        workspaceId: workspace.workspaceId,
        status: { not: 'CANCELLED' },
        ...brandIdScopeFilter(workspace.brandScope),
        scheduledAtUtc: { gte: systemClock.now() },
      },
      orderBy: { scheduledAtUtc: 'asc' },
      take: 5,
      select: {
        id: true,
        scheduledAtUtc: true,
        contentItemId: true,
        item: { select: { title: true, status: true } },
      },
    });
    const inReview = await scoped.db.contentItem.count({
      where: {
        workspaceId: workspace.workspaceId,
        deletedAt: null,
        status: 'IN_REVIEW',
        ...brandIdScopeFilter(workspace.brandScope),
      },
    });
    return { recent, unread, pendingApprovals: 0, inReview, upcoming, scope: 'ok' };
  });

  /*
   * The queue count comes from the Approvals service itself, which applies the
   * same brand scoping its own screen does.
   *
   * THE MEMBERSHIP SCOPE IS PASSED THROUGH UNCHANGED. It used to be expanded
   * here — an empty scope was replaced with "every brand id" — because the
   * service read an empty list as "no brands" and would otherwise have returned
   * zero. That workaround was a second implementation of the BrandScope rule
   * living in a page, and the place the two would drift apart. The service now
   * honours the platform rule directly, so the page hands it what the session
   * holds and nothing more.
   */
  const pendingApprovals = maySeeContent
    ? await inContentStudio(workspace.workspaceId, async ({ approvals }) =>
        (await approvals()).pendingCount(workspace.brandScope),
      )
    : 0;

  const overviewDateFormat = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });

  /*
   * Both hero actions go somewhere real, and to a page the reader is actually
   * allowed to open — §20 forbids a dead button or a `#` placeholder, and a
   * primary action that lands on a 404 is worse than no primary action.
   */
  const primaryHref = maySeeMembers ? `/${locale}/members` : `/${locale}/settings`;
  const primaryLabel = maySeeMembers ? t('overview.hero.primary') : t('nav.settings');

  /*
   * WHAT NEEDS A PERSON — THE COMMAND CENTER'S FIRST QUESTION (P6-04).
   *
   * Above this, the page answers "how is the workspace doing" with real figures
   * and honest unavailable states, which it has always done well. What it never
   * answered is the question somebody opening it actually has, and the result
   * was a member reading four correct numbers and still having to go looking.
   *
   * It runs in the same tenant-scoped transaction the summary uses, so it costs
   * one round trip rather than five, and every source is gated by the permission
   * its destination requires — an attention item is a link, and pointing
   * somebody at a route that answers 404 is a dead link delivered as a to-do.
   */
  const attention = await inWorkspace(workspace.workspaceId, async (scoped) =>
    attentionItems(scoped.db, workspace),
  );

  const brandContext = await brandContextFor(workspace, '/overview');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      activePath="/overview"
      heading={t('overview.greeting')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
      hero={
        <OverviewHero
          eyebrow={workspace.workspaceName}
          title={t('overview.hero.title')}
          description={t('overview.hero.body')}
          primaryAction={
            <Link href={primaryHref} style={buttonStyle('primary')} data-testid="hero-primary">
              {primaryLabel}
            </Link>
          }
          visual={
            /*
             * The demo's two floating cards, at its exact geometry, carrying
             * honest content: it captions them with engagement and schedule
             * figures this phase cannot measure, so each says instead what it
             * will hold and that it holds nothing yet (§33).
             */
            <>
              <HeroFloatCard
                placement="end"
                title={t('overview.float.performance')}
                detail={t('overview.metric.laterPhase')}
              >
                <HeroMiniChart />
              </HeroFloatCard>
              <HeroFloatCard
                placement="start"
                title={t('overview.float.next')}
                detail={t('overview.upcomingEmptyTitle')}
              />
            </>
          }
          secondaryAction={
            <Link
              href={`/${locale}/settings`}
              data-testid="hero-secondary"
              style={{
                ...buttonStyle('ghost'),
                background: 'transparent',
                color: colorTokens.textPrimary,
              }}
            >
              {t('overview.hero.secondary')}
              <span aria-hidden="true">→</span>
            </Link>
          }
        />
      }
    >
      <Stack>
        {/*
          THE ATTENTION LIST COMES FIRST, ABOVE THE STATISTICS.

          Ordering is the whole point of a Command Center: what needs doing
          outranks how things are going. The statistics below are unchanged and
          still answer the second question.

          NO EMPTY-STATE CLUTTER. When nothing is waiting, this is ONE sentence
          saying so — not a card, not an illustration, not a zero. A workspace
          with nothing outstanding is a good state and should read like one.
        */}
        <Card testId="attention-card">
          <SectionHeader title={t('attention.title')} />
          {attention.length === 0 ? (
            <p
              data-testid="attention-none"
              style={{ margin: 0, ...typographyTokens.body, color: colorTokens.textSecondary }}
            >
              {t('attention.none')}
            </p>
          ) : (
            <ul
              data-testid="attention-list"
              style={{
                margin: 0,
                padding: 0,
                listStyle: 'none',
                display: 'grid',
                gap: spacingTokens.sm,
              }}
            >
              {attention.map((item) => (
                <li key={item.kind}>
                  <Link
                    href={`/${locale}${item.href}`}
                    data-testid={`attention-${item.kind}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: spacingTokens.sm,
                      padding: spacingTokens.sm,
                      borderRadius: '0.75rem',
                      color: colorTokens.textPrimary,
                      textDecoration: 'none',
                    }}
                    className="bs-control bs-pressable"
                  >
                    {/*
                      The badge carries the severity as a WORD as well as a
                      colour — colour alone fails WCAG 1.4.1, and "blocked" and
                      "waiting" are genuinely different instructions.
                    */}
                    <StatusBadge
                      tone={item.severity === 'blocked' ? 'danger' : statusTone(item.severity)}
                      label={t(`attention.severity.${item.severity}` as never)}
                    />
                    <span style={{ ...typographyTokens.body }}>{attentionSentence(t, item)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/*
          `.metric-row { grid-template-columns: repeat(4,1fr) }`, stepping to
          TWO columns at 900 and staying at two down to 390 — the demo never
          gives a phone a single column of statistics. A 12rem floor could not
          fit two inside 366px and collapsed to one, which made the Overview
          four tall cards deep before the first section.
        */}
        <ContentGrid min="10rem" testId="overview-metrics">
          <MetricCard
            label={t('overview.metric.plan')}
            value={effective?.planKey ?? undefined}
            unavailable={!maySeeBilling || !effective?.planKey}
            unavailableLabel={maySeeBilling ? t('plan.none') : t('overview.metric.hidden')}
            hint={t('overview.metric.planHint')}
            testId="metric-plan"
          />
          <MetricCard
            label={t('overview.metric.credits')}
            value={wallet ? String(wallet.balanceCredits) : undefined}
            unavailable={!wallet}
            unavailableLabel={t('overview.metric.hidden')}
            hint={t('overview.metric.creditsHint')}
            testId="metric-credits"
          />
          <MetricCard
            label={t('overview.metric.members')}
            value={memberCount === null ? undefined : String(memberCount)}
            unavailable={memberCount === null}
            unavailableLabel={t('overview.metric.hidden')}
            testId="metric-members"
          />
          {/*
            PHASE 5B-3 REPLACED THE FOURTH PLACEHOLDER WITH A REAL FIGURE. "In
            review" is now measurable because there is a review workflow behind
            it; "published" still is not, and has moved below rather than being
            quietly rendered as a zero.
          */}
          <MetricCard
            label={t('overview.metric.inReview')}
            value={maySeeContent ? String(summary.inReview) : undefined}
            unavailable={!maySeeContent}
            unavailableLabel={t('overview.metric.hidden')}
            testId="metric-in-review"
          />
          <MetricCard
            label={t('overview.metric.scheduled')}
            value={maySeeContent ? String(summary.upcoming.length) : undefined}
            unavailable={!maySeeContent}
            unavailableLabel={t('overview.metric.hidden')}
            hint={t('overview.metric.scheduledHint')}
            testId="metric-scheduled"
          />
          {/*
            PHASE 7 MAKES THIS ONE REAL, AND ONLY BECAUSE THERE IS SOMETHING TO
            MEASURE.

            The card said "available when publishing ships" through Phases 5B-2
            and 6, because a zero there would have read as "you published
            nothing" — a fabricated measurement of a feature that did not exist
            (CLAUDE.md §2.2). Publishing shipped in Phase 6 and analytics
            ingestion in Phase 7, so the number is now a real sum over stored
            observations.

            IT IS STILL UNAVAILABLE RATHER THAN ZERO when there is no
            measurement: `engagements === null` means no reading has arrived,
            which is a different thing from a measured none, and the card keeps
            saying which.
          */}
          <MetricCard
            label={t('overview.metric.engagement')}
            {...(engagements === null
              ? {
                  unavailable: true,
                  unavailableLabel: maySeeAnalytics
                    ? t('analytics.absent.metrics_pending')
                    : t('overview.metric.hidden'),
                }
              : {
                  value: new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en').format(engagements),
                })}
            hint={t('overview.metric.engagementHint')}
            testId="metric-engagement"
          />
        </ContentGrid>

        <div className="bs-split-main">
          <Stack>
            {/*
              The reference's "Next on your calendar". The composition is
              reproduced; the two posts inside it are not, because a scheduled
              post cannot exist before the schedule does.
            */}
            <Card testId="overview-upcoming">
              <SectionHeader
                eyebrow={t('overview.upcomingKicker')}
                title={t('overview.upcoming')}
                actions={
                  maySeeContent ? (
                    <Link href={`/${locale}/calendar`} style={buttonStyle('neutral', 'sm')}>
                      {t('overview.upcomingSeeAll')}
                    </Link>
                  ) : undefined
                }
              />
              {summary.upcoming.length === 0 ? (
                <StateMessage
                  title={t('overview.upcomingEmptyTitle')}
                  description={t('overview.upcomingEmptyBody')}
                />
              ) : (
                <ul style={panelListStyle} data-testid="overview-upcoming-list">
                  {summary.upcoming.map((slot) => (
                    <li key={slot.id} style={panelRowStyle}>
                      <Link
                        href={`/${locale}/content/compose?item=${slot.contentItemId}`}
                        style={{ ...typographyTokens.bodySm, fontWeight: 600 }}
                      >
                        {slot.item?.title ?? '—'}
                      </Link>
                      <span style={panelMetaStyle}>
                        <time dateTime={slot.scheduledAtUtc.toISOString()}>
                          {overviewDateFormat.format(slot.scheduledAtUtc)}
                        </time>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/*
              PHASE 5B-3 — "NEEDS YOUR APPROVAL", the widget docs/PRODUCT.md
              §5.1 names first. The count comes from the Approvals service, so it
              carries that module's brand scoping rather than a second copy of it.
            */}
            <Card testId="overview-approvals">
              <SectionHeader
                eyebrow={t('overview.needsApprovalKicker')}
                title={t('overview.needsApproval')}
                actions={
                  maySeeContent ? (
                    <Link href={`/${locale}/approvals`} style={buttonStyle('neutral', 'sm')}>
                      {t('overview.approvalsSeeAll')}
                    </Link>
                  ) : undefined
                }
              />
              {pendingApprovals === 0 ? (
                <StateMessage
                  title={t('overview.needsApprovalEmptyTitle')}
                  description={t('overview.needsApprovalEmptyBody')}
                />
              ) : (
                <p
                  style={{ margin: 0, ...typographyTokens.bodySm }}
                  data-testid="overview-approvals-count"
                >
                  {pendingApprovals}
                </p>
              )}
            </Card>

            <Card testId="overview-activity">
              <SectionHeader
                title={t('overview.activity')}
                actions={
                  <Link href={`/${locale}/activity`} style={buttonStyle('neutral', 'sm')}>
                    {t('overview.activitySeeAll')}
                  </Link>
                }
              />
              {summary.recent.length === 0 ? (
                <StateMessage
                  title={t('overview.activityEmptyTitle')}
                  description={t('overview.activityEmptyBody')}
                />
              ) : (
                <ul style={panelListStyle} data-testid="overview-activity-list">
                  {summary.recent.map((entry) => (
                    <li key={entry.id} style={panelRowStyle}>
                      <span style={{ ...typographyTokens.bodySm, fontWeight: 600 }}>
                        {entry.action}
                      </span>
                      <span style={panelMetaStyle}>
                        <time dateTime={entry.occurredAt.toISOString()}>
                          {overviewDateFormat.format(entry.occurredAt)}
                        </time>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Stack>

          <Stack>
            <Card
              testId="overview-notifications"
              title={t('notifications.title')}
              actions={
                <Link href={`/${locale}/notifications`} style={buttonStyle('neutral', 'sm')}>
                  {t('notifications.open')}
                </Link>
              }
            >
              <p
                style={{ margin: 0, ...typographyTokens.bodySm }}
                data-testid="overview-unread-count"
              >
                {t('notifications.unread')}: {summary.unread}
              </p>
            </Card>

            <Card testId="overview-copilot">
              <SectionHeader eyebrow={t('overview.copilotKicker')} title={t('overview.copilot')} />
              <StateMessage
                title={t('overview.copilotEmptyTitle')}
                description={t('overview.copilotEmptyBody')}
              />
            </Card>

            <Card testId="overview-identity">
              <SectionHeader
                title={t('overview.workspaceSection')}
                description={t('overview.workspaceSectionHint')}
                actions={
                  <StatusBadge
                    label={workspace.workspaceStatus}
                    tone={statusTone(workspace.workspaceStatus)}
                    testId={`workspace-status-${workspace.workspaceStatus}`}
                  />
                }
              />
              <dl style={{ margin: 0, display: 'grid', gap: spacingTokens.sm }}>
                {[
                  {
                    label: t('overview.field.signedInAs'),
                    value: customer.email,
                    testId: 'signed-in-as',
                  },
                  { label: t('overview.field.workspace'), value: workspace.workspaceName },
                  {
                    label: t('overview.field.role'),
                    value: locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn,
                  },
                ].map((row) => (
                  <div key={row.label} style={{ display: 'grid', gap: spacingTokens['3xs'] }}>
                    <dt
                      style={{
                        ...typographyTokens.caption,
                        color: colorTokens.textMuted,
                      }}
                    >
                      {row.label}
                    </dt>
                    <dd
                      data-testid={row.testId}
                      style={{
                        margin: 0,
                        ...typographyTokens.bodySm,
                        fontWeight: 600,
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>

            {maySeeBilling && effective ? (
              <Card
                title={t('plan.current')}
                testId="overview-plan"
                actions={
                  <Link href={`/${locale}/plan`} style={buttonStyle('neutral', 'sm')}>
                    {t('nav.plan')}
                  </Link>
                }
              >
                <p
                  style={{ margin: 0, ...typographyTokens.bodySm }}
                  data-testid="overview-plan-key"
                >
                  {effective.planKey ?? t('plan.none')}
                </p>
                {wallet ? (
                  <p style={{ marginBlockEnd: 0, ...typographyTokens.bodySm }}>
                    {t('plan.credits')}:{' '}
                    <strong data-testid="overview-credits">{wallet.balanceCredits}</strong>
                  </p>
                ) : null}
              </Card>
            ) : null}
          </Stack>
        </div>
      </Stack>
    </WorkspaceShell>
  );
}

const panelListStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gap: spacingTokens.xs,
} as const;

const panelRowStyle = {
  display: 'flex',
  gap: spacingTokens.xs,
  justifyContent: 'space-between',
  alignItems: 'baseline',
  flexWrap: 'wrap',
} as const;

const panelMetaStyle = { ...typographyTokens.caption, color: colorTokens.textMuted } as const;
