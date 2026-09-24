import Link from 'next/link';
import { CopilotLink } from '../../../components/copilot-link';
import type { ReactNode } from 'react';
import {
  Card,
  ContentGrid,
  HeroFloatCard,
  MetricCard,
  OverviewHero,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  radiusTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
} from '@brandspace/ui';
import { localizedFrom } from '@brandspace/brand-brain';
import { NOTE_PERMISSION, NotesService, type NoteInboxEntry } from '@brandspace/collaboration';
import { brandIdQueryFilter, systemClock } from '@brandspace/shared';
import { detectAnomalies } from '@brandspace/analytics';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inContentStudio } from '../../../server/content-context';
import { decidePreferenceAction } from './actions';
import { inAnalytics } from '../../../server/analytics-context';
import { attentionItems, rankAttention, type AttentionItem } from '../../../server/command-center';
import {
  PERFORMANCE_SHIFT_RECENT_DAYS,
  latestShift,
  performanceShiftItem,
} from '../../../server/performance-patterns';
import {
  HOME_NOTES,
  HOME_RECOMMENDATIONS,
  HOME_UPCOMING_DAYS,
  RECOMMENDATION_INSIGHT_TYPES,
  attentionAction,
  greetingName,
  greetingPeriod,
  groupByDay,
  hourIn,
  relativeTime,
  safeZone,
  shouldInviteSetup,
} from '../../../server/home';
import { setupFactsFor } from '../../../server/setup-wizard';
import { mentionableMembers } from '../../../server/notes-context';
import { noteThreadHref } from '../../../server/note-links';
import {
  optionalMessage,
  statusMessage,
  translator,
  type MessageKey,
} from '../../../i18n/messages';
import { copilotHref } from '../../../server/copilot-surface';
import { WorkspaceShell } from '../../../components/workspace-shell';
import { resolveNoteThreadAction } from '../notes-actions';
import { reviewIntelligenceAction } from '../intelligence/actions';

export const dynamic = 'force-dynamic';

/**
 * The sentence for one attention item, in the reader's language.
 *
 * `{count}` and `{detail}` are substituted rather than concatenated, so Arabic
 * can put the number where Arabic puts it (CLAUDE.md §4). Two kinds need a
 * different sentence for one versus many — "Northwind has no brand knowledge
 * yet" is actionable in a way "1 brand" is not.
 */
const NAMED_OR_COUNTED = new Set(['brand-brain-empty', 'campaign-empty', 'calendar-gap']);

/** Kinds whose `detail` is a metric key, translated rather than printed. */
const METRIC_DETAIL = new Set(['performance-above', 'performance-below']);

function attentionSentence(
  t: (key: never) => string,
  item: AttentionItem,
  formatDate: (value: Date) => string,
): string {
  const key =
    item.detail === undefined && NAMED_OR_COUNTED.has(item.kind)
      ? `attention.${item.kind}.many`
      : `attention.${item.kind}`;
  const detail =
    item.detail !== undefined && METRIC_DETAIL.has(item.kind)
      ? t(`analytics.metric.${item.detail}` as never)
      : (item.detail ?? '');
  return t(key as never)
    .replace('{count}', String(item.count))
    .replace('{detail}', detail)
    .replace('{date}', item.date ? formatDate(item.date) : '')
    .replace('{secondDate}', item.secondDate ? formatDate(item.secondDate) : '');
}

/**
 * HOME — "What needs me now? What should I do next? What did BrandSpace
 * notice?" (Phase 6 final, D-277 §7).
 *
 * IN THE OWNER'S ORDER, and the order is the point:
 *
 *   top  a greeting and the brand this is about;
 *   A    What needs you — the Command Center's attention sources, each a
 *        sentence with ONE action and a link to where it is done;
 *   B    Recommended by BrandSpace — at most three grounded recommendations
 *        from the insight domain, each with its evidence, a way to hand it to
 *        the Copilot, and Dismiss;
 *   C    Notes — the actual conversations waiting on the reader, not a count;
 *   D    Coming up — the next seven days, compact;
 *   E    Performance — real figures, last.
 *
 * NOTHING HERE IS NEW DATA. Every section reads the module that owns it —
 * `attentionItems`, `Insight` rows, `NotesService.inbox`, calendar slots,
 * `AnalyticsQueryService` — under the reader's BrandScope and the rail's
 * brand, so Home and the module screens cannot disagree. A section with
 * nothing real to say says so in one line; it never shows a zero standing in
 * for "unknown", and it never fabricates a recommendation.
 *
 * Plan, credits, members, the activity log and the notification count left
 * Home: they are account facts, and each has its place in Settings or the top
 * bar (D-277 §3/§4).
 */
export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale);
  const may = (key: string) => workspace.permissionKeys.includes(key);

  const maySeeContent = may('content.read');
  const maySeeAnalytics = may('analytics.read');
  const mayUseCopilot = may('copilot.use');
  const maySeeInsights = may('strategy.read');
  const mayReviewInsights = may('strategy.manage');
  const mayUseNotes = may(NOTE_PERMISSION);

  const brandContext = await brandContextFor(workspace, '/overview');
  const brand = requiredBrand(brandContext);
  const brandId =
    brandContext.resolution.kind === 'brand' ? brandContext.resolution.brand.id : undefined;
  const now = systemClock.now();

  const timeZone = safeZone(
    await inWorkspace(workspace.workspaceId, async ({ db }) =>
      db.workspace
        .findUnique({ where: { id: workspace.workspaceId }, select: { timezone: true } })
        .then((row) => row?.timezone ?? null),
    ),
  );

  /* ------------------------------------------------------------ A — attention */
  const performanceShift = maySeeAnalytics
    ? await inAnalytics(workspace.workspaceId, async (services) => {
        const queries = await services.queries();
        const series = await queries.series({
          scope: {},
          period: { start: new Date(now.getTime() - 28 * 86_400_000), end: now },
          metricKey: 'engagements',
          brandScope: workspace.brandScope,
        });
        return performanceShiftItem(
          latestShift(
            detectAnomalies({
              metricKey: series.metricKey,
              unit: series.unit,
              points: series.points,
              policy: await services.policy(),
            }),
            { now, withinDays: PERFORMANCE_SHIFT_RECENT_DAYS },
          ),
        );
      }).catch(() => null)
    : null;

  const attention = rankAttention([
    ...(await inWorkspace(workspace.workspaceId, async (scoped) =>
      attentionItems(scoped.db, workspace, customer.userId),
    )),
    ...(performanceShift ? [performanceShift] : []),
  ]);

  /* ------------------------------------------------------ B — recommendations */
  const recommendations = maySeeInsights
    ? await inWorkspace(workspace.workspaceId, async ({ db }) =>
        db.insight.findMany({
          where: {
            workspaceId: workspace.workspaceId,
            ...brandIdQueryFilter({ brandId, brandScope: workspace.brandScope }),
            type: { in: [...RECOMMENDATION_INSIGHT_TYPES] },
            status: { in: ['NEW', 'SEEN'] },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          orderBy: [{ confidenceMilli: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
          take: HOME_RECOMMENDATIONS,
          select: {
            id: true,
            type: true,
            basis: true,
            title: true,
            body: true,
            createdAt: true,
            _count: { select: { evidence: true } },
          },
        }),
      )
    : [];

  /* ---------------------------------------------------------------- C — notes */
  const inbox = mayUseNotes
    ? await inWorkspace(workspace.workspaceId, async ({ db }) =>
        new NotesService({ db, workspaceId: workspace.workspaceId, clock: systemClock }).inbox(
          {
            userId: customer.userId,
            permissionKeys: workspace.permissionKeys,
            brandScope: workspace.brandScope,
          },
          { brandId: brandId ?? null },
        ),
      )
    : null;
  const conversations: readonly NoteInboxEntry[] = inbox
    ? [...inbox.forYou, ...inbox.open].slice(0, HOME_NOTES)
    : [];
  const members = conversations.length > 0 ? await mentionableMembers(locale) : [];
  const nameOf = (userId: string): string =>
    members.find((member) => member.userId === userId)?.name ?? t('notes.someone');

  /* ------------------------------------------------ D + E — schedule, figures */
  const horizon = new Date(now.getTime() + HOME_UPCOMING_DAYS * 86_400_000);
  const schedule = maySeeContent
    ? await inWorkspace(workspace.workspaceId, async ({ db }) => {
        const scope = brandIdQueryFilter({ brandId, brandScope: workspace.brandScope });
        const [upcoming, inReview, published] = await Promise.all([
          db.calendarSlot.findMany({
            where: {
              workspaceId: workspace.workspaceId,
              status: { in: ['PLANNED', 'SCHEDULED', 'PUBLISHING'] },
              ...scope,
              scheduledAtUtc: { gte: now, lt: horizon },
            },
            orderBy: { scheduledAtUtc: 'asc' },
            take: 20,
            select: {
              id: true,
              status: true,
              scheduledAtUtc: true,
              contentItemId: true,
              item: { select: { title: true } },
            },
          }),
          db.contentItem.count({
            where: {
              workspaceId: workspace.workspaceId,
              deletedAt: null,
              status: 'IN_REVIEW',
              ...scope,
            },
          }),
          db.publishJob.count({
            where: {
              workspaceId: workspace.workspaceId,
              status: 'PUBLISHED',
              publishedAt: { gte: new Date(now.getTime() - 28 * 86_400_000) },
              ...scope,
            },
          }),
        ]);
        return { upcoming, inReview, published };
      })
    : null;

  const pendingApprovals = maySeeContent
    ? await inContentStudio(workspace.workspaceId, async ({ approvals }) =>
        (await approvals()).pendingCount(workspace.brandScope),
      )
    : null;

  /*
   * D-295 — PREFERENCES BRANDSPACE NOTICED in this member's own edits for the
   * selected brand. Derived from the audit trail past the configured
   * thresholds; one already decided on is not shown again. Two at most.
   */
  const noticedPreferences =
    brandId && may('content.create')
      ? (
          await inContentStudio(workspace.workspaceId, async ({ suggestions }) =>
            (await suggestions()).noticedPreferences({
              userId: customer.userId,
              brandId,
              brandScope: workspace.brandScope,
            }),
          )
        ).slice(0, 2)
      : [];

  const engagements = maySeeAnalytics
    ? await inAnalytics(workspace.workspaceId, async (services) => {
        const queries = await services.queries();
        const result = await queries.summary({
          scope: brandId ? { brandId } : {},
          period: { start: new Date(now.getTime() - 28 * 86_400_000), end: now },
          brandScope: workspace.brandScope,
          metricKeys: ['engagements'],
        });
        const metric = result.metrics.find((entry) => entry.metricKey === 'engagements');
        return metric?.value === null || metric?.value === undefined ? null : Number(metric.value);
      }).catch(() => null)
    : null;

  /* ------------------------------------------------------------------- setup */
  const setup = await setupFactsFor(workspace.workspaceId, brand?.id ?? null);
  const inviteSetup =
    brandContext.resolution.kind !== 'unselected' &&
    brandContext.resolution.kind !== 'all' &&
    shouldInviteSetup({
      hasBrand: brand !== null,
      sources: setup.sources.total,
      connections: setup.activeConnections,
      hasGoal: setup.goal !== null,
    });

  /* -------------------------------------------------------------- formatting */
  const dayFormat = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    timeZone,
  });
  const timeFormat = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  const attentionDate = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeZone,
  });
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en');
  const pick = (value: unknown) => {
    const text = localizedFrom(value as never);
    return (locale === 'ar' ? (text.ar ?? text.en) : (text.en ?? text.ar)) ?? '';
  };

  const period = greetingPeriod(hourIn(now, timeZone));
  const firstName = greetingName(customer.name);
  const greeting = firstName
    ? t(`home.greeting.${period}` as MessageKey).replace('{name}', firstName)
    : t(`home.greeting.${period}.plain` as MessageKey);

  const noteHref = (entry: NoteInboxEntry): string => noteThreadHref(locale, entry);

  const nextSlot = schedule?.upcoming[0] ?? null;
  const ok = typeof query['ok'] === 'string' ? statusMessage(query['ok'], locale) : null;

  const quiet = (text: string, testId: string): ReactNode => (
    <p
      data-testid={testId}
      style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
    >
      {text}
    </p>
  );

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
          eyebrow={brand?.name ?? workspace.workspaceName}
          title={greeting}
          description={t('home.hero.body')}
          primaryAction={
            may('content.create') ? (
              <Link
                href={`/${locale}/content/compose`}
                style={buttonStyle('primary')}
                className={buttonClass('primary')}
                data-testid="hero-primary"
              >
                {t('home.hero.create')}
              </Link>
            ) : undefined
          }
          secondaryAction={
            mayUseCopilot ? (
              <CopilotLink
                href={copilotHref(locale, 'overview')}
                data-testid="overview-copilot-open"
                style={{
                  ...buttonStyle('ghost'),
                  background: 'transparent',
                  color: colorTokens.textPrimary,
                }}
              >
                {t('home.hero.copilot')}
                <span aria-hidden="true">→</span>
              </CopilotLink>
            ) : undefined
          }
          visual={
            /*
             * The demo's two floating cards at its exact geometry, carrying
             * REAL content: the 28-day engagement figure (or the reason there
             * is none) and the next thing going out (or that nothing is).
             */
            <>
              <HeroFloatCard
                placement="end"
                title={t('overview.float.performance')}
                detail={
                  engagements === null
                    ? t('analytics.absent.metrics_pending')
                    : t('home.float.engagements').replace('{count}', number.format(engagements))
                }
              />
              <HeroFloatCard
                placement="start"
                title={t('overview.float.next')}
                detail={
                  nextSlot
                    ? `${nextSlot.item?.title ?? '—'} · ${dayFormat.format(nextSlot.scheduledAtUtc)}`
                    : t('overview.upcomingEmptyTitle')
                }
              />
            </>
          }
        />
      }
    >
      <Stack>
        {ok ? (
          <p role="status" style={{ margin: 0, ...typographyTokens.bodySm }}>
            {ok}
          </p>
        ) : null}

        {inviteSetup ? (
          <Card testId="home-setup" tone="lavender">
            <SectionHeader
              title={brand ? t('home.setup.continueTitle') : t('home.setup.startTitle')}
              description={brand ? t('home.setup.continueBody') : t('home.setup.startBody')}
              actions={
                <Link
                  href={`/${locale}/onboarding`}
                  style={buttonStyle('brand', 'sm')}
                  className={buttonClass('brand')}
                  data-testid="home-setup-open"
                >
                  {t('home.setup.open')}
                </Link>
              }
            />
          </Card>
        ) : null}

        {/* ------------------------------------------------ A — WHAT NEEDS YOU */}
        <Card testId="attention-card">
          <SectionHeader
            title={t('attention.title')}
            actions={
              mayUseCopilot && attention.length > 0 ? (
                <CopilotLink
                  href={copilotHref(locale, 'overview')}
                  style={buttonStyle('ghost', 'sm')}
                  className={buttonClass('ghost')}
                  data-testid="attention-ask-copilot"
                >
                  {t('copilot.ask')}
                </CopilotLink>
              ) : undefined
            }
          />
          {attention.length === 0 ? (
            quiet(t('attention.none'), 'attention-none')
          ) : (
            <ul data-testid="attention-list" style={listStyle}>
              {attention.map((item) => (
                <li key={item.kind} data-testid={`attention-${item.kind}`} style={rowStyle}>
                  {/*
                    The badge carries the severity as a WORD as well as a
                    colour — colour alone fails WCAG 1.4.1.
                  */}
                  <StatusBadge
                    tone={item.severity === 'blocked' ? 'danger' : statusTone(item.severity)}
                    label={t(`attention.severity.${item.severity}` as never)}
                  />
                  <span style={{ ...typographyTokens.body, flex: '1 1 14rem', minInlineSize: 0 }}>
                    {attentionSentence(t, item, (value) => attentionDate.format(value))}
                  </span>
                  <Link
                    href={`/${locale}${item.href}`}
                    style={buttonStyle('neutral', 'sm')}
                    className={buttonClass('neutral')}
                    data-testid={`attention-action-${item.kind}`}
                  >
                    {t(`home.action.${attentionAction(item.kind)}` as MessageKey)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* --------------------------------------- B — RECOMMENDED BY BRANDSPACE */}
        {maySeeInsights ? (
          <Card testId="home-recommended">
            <SectionHeader
              title={t('home.recommended.title')}
              description={t('home.recommended.body')}
            />
            {recommendations.length === 0 ? (
              quiet(t('home.recommended.none'), 'home-recommended-none')
            ) : (
              <ul style={listStyle}>
                {recommendations.map((insight) => (
                  <li
                    key={insight.id}
                    data-testid={`home-recommendation-${insight.id}`}
                    style={{ ...rowStyle, alignItems: 'flex-start', flexDirection: 'column' }}
                  >
                    <strong style={typographyTokens.body}>{pick(insight.title)}</strong>
                    <span style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
                      {pick(insight.body)}
                    </span>
                    <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                      {t('home.recommended.evidence')
                        .replace('{count}', String(insight._count.evidence))
                        .replace('{basis}', t(`home.basis.${insight.basis}` as MessageKey))}
                    </span>
                    <div style={actionsStyle}>
                      <Link
                        href={`/${locale}/intelligence?insight=${insight.id}`}
                        style={buttonStyle('neutral', 'sm')}
                        className={buttonClass('neutral')}
                        data-testid={`home-recommendation-evidence-${insight.id}`}
                      >
                        {t('home.recommended.viewEvidence')}
                      </Link>
                      {mayUseCopilot ? (
                        <CopilotLink
                          href={copilotHref(locale, 'intelligence')}
                          style={buttonStyle('ghost', 'sm')}
                          className={buttonClass('ghost')}
                        >
                          {t('home.recommended.giveToCopilot')}
                        </CopilotLink>
                      ) : null}
                      {mayReviewInsights ? (
                        <form action={reviewIntelligenceAction}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="insightId" value={insight.id} />
                          <input type="hidden" name="decision" value="dismiss" />
                          <input type="hidden" name="returnTo" value="/overview" />
                          <button
                            type="submit"
                            style={buttonStyle('ghost', 'sm')}
                            className={buttonClass('ghost')}
                            data-testid={`home-recommendation-dismiss-${insight.id}`}
                          >
                            {t('insights.dismiss')}
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}

        {/*
          D-295 — "BrandSpace noticed a preference": a PREFERENCE, drawn apart
          from the evidence-backed insights above because it is about how this
          person works, not about the brand's performance. It changes nothing
          until they choose "Make this my default".
        */}
        {noticedPreferences.length > 0 && brandId ? (
          <Card testId="home-noticed">
            <SectionHeader
              title={t('home.preference.title')}
              description={t('home.preference.body')}
            />
            <ul style={listStyle}>
              {noticedPreferences.map((preference) => (
                <li
                  key={preference.key}
                  data-testid={`home-preference-${preference.key}`}
                  style={{ ...rowStyle, alignItems: 'flex-start' }}
                >
                  <div style={{ display: 'grid', gap: spacingTokens['3xs'], flex: '1 1 14rem' }}>
                    <StatusBadge tone="info" label={t('home.preference.badge')} />
                    <strong style={{ ...typographyTokens.bodySm, color: colorTokens.textPrimary }}>
                      {(preference.tool === 'shorten'
                        ? t('home.preference.shorter')
                        : t('home.preference.tone').replace(
                            '{tone}',
                            t(
                              `home.preference.tone.${preference.tone ?? 'professional'}` as MessageKey,
                            ),
                          )
                      ).replace(
                        '{platform}',
                        optionalMessage(locale, `content.platform.${preference.platformKey}`) ??
                          preference.platformKey,
                      )}
                    </strong>
                    <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                      {t('home.preference.evidence')
                        .replace('{count}', String(preference.observations))
                        .replace('{posts}', String(preference.posts))}
                    </span>
                  </div>
                  <div style={actionsStyle}>
                    {(['accept', 'snooze', 'dismiss'] as const).map((decision) => (
                      <form key={decision} action={decidePreferenceAction}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="brandId" value={brandId} />
                        <input type="hidden" name="key" value={preference.key} />
                        <input type="hidden" name="decision" value={decision} />
                        <button
                          type="submit"
                          style={buttonStyle(decision === 'accept' ? 'primary' : 'ghost', 'sm')}
                          className={buttonClass(decision === 'accept' ? 'primary' : 'ghost')}
                          data-testid={`home-preference-${decision}-${preference.key}`}
                        >
                          {t(`home.preference.${decision}` as MessageKey)}
                        </button>
                      </form>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <div className="bs-split-main">
          {/* ------------------------------------------------------ C — NOTES */}
          {mayUseNotes ? (
            <Card testId="home-notes">
              <SectionHeader
                title={t('home.notes.title')}
                actions={
                  <Link
                    href={`/${locale}/notes`}
                    style={buttonStyle('neutral', 'sm')}
                    className={buttonClass('neutral')}
                  >
                    {t('home.notes.all')}
                  </Link>
                }
              />
              {conversations.length === 0 ? (
                quiet(t('home.notes.none'), 'home-notes-none')
              ) : (
                <ul style={listStyle}>
                  {conversations.map((entry) => {
                    const author = entry.lastNote ? nameOf(entry.lastNote.authorUserId) : null;
                    return (
                      <li
                        key={entry.threadId}
                        data-testid={`home-note-${entry.threadId}`}
                        style={{ ...rowStyle, alignItems: 'flex-start' }}
                      >
                        <span aria-hidden="true" style={avatarStyle}>
                          {(author ?? entry.brandName).slice(0, 1).toUpperCase()}
                        </span>
                        <div
                          style={{
                            display: 'grid',
                            gap: spacingTokens['3xs'],
                            flex: '1 1 12rem',
                            minInlineSize: 0,
                          }}
                        >
                          <span style={{ ...typographyTokens.bodySm, fontWeight: 600 }}>
                            {author ?? entry.brandName}
                            {entry.unreadMentions > 0 ? (
                              <>
                                {' '}
                                <StatusBadge
                                  label={t('notesInbox.unread').replace(
                                    '{count}',
                                    String(entry.unreadMentions),
                                  )}
                                  tone="warning"
                                  dot
                                />
                              </>
                            ) : null}
                          </span>
                          {entry.lastNote ? (
                            <span
                              dir="auto"
                              style={{
                                ...typographyTokens.bodySm,
                                color: colorTokens.textSecondary,
                                overflowWrap: 'anywhere',
                              }}
                            >
                              {entry.lastNote.body}
                            </span>
                          ) : null}
                          <span
                            style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}
                          >
                            {entry.subjectTitle ?? entry.brandName} ·{' '}
                            <time dateTime={entry.updatedAt.toISOString()}>
                              {relativeTime(entry.updatedAt, now, locale)}
                            </time>
                          </span>
                          <div style={actionsStyle}>
                            <Link
                              href={noteHref(entry)}
                              style={buttonStyle('neutral', 'sm')}
                              className={buttonClass('neutral')}
                              data-testid={`home-note-open-${entry.threadId}`}
                            >
                              {t(`home.notes.open.${entry.subjectType}` as MessageKey)}
                            </Link>
                            {entry.status === 'OPEN' ? (
                              <form action={resolveNoteThreadAction}>
                                <input type="hidden" name="locale" value={locale} />
                                <input type="hidden" name="threadId" value={entry.threadId} />
                                <input
                                  type="hidden"
                                  name="returnPath"
                                  value={`/${locale}/overview`}
                                />
                                <button
                                  type="submit"
                                  style={buttonStyle('ghost', 'sm')}
                                  className={buttonClass('ghost')}
                                  data-testid={`home-note-resolve-${entry.threadId}`}
                                >
                                  {t('home.notes.resolve')}
                                </button>
                              </form>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          ) : null}

          {/* -------------------------------------------------- D — COMING UP */}
          {schedule ? (
            <Card testId="overview-upcoming">
              <SectionHeader
                eyebrow={t('overview.upcomingKicker')}
                title={t('home.upcoming.title')}
                actions={
                  <Link
                    href={`/${locale}/calendar`}
                    style={buttonStyle('neutral', 'sm')}
                    className={buttonClass('neutral')}
                    data-testid="overview-upcoming-calendar"
                  >
                    {t('overview.upcomingSeeAll')}
                  </Link>
                }
              />
              {schedule.upcoming.length === 0 ? (
                <StateMessage
                  title={t('overview.upcomingEmptyTitle')}
                  description={t('home.upcoming.empty')}
                />
              ) : (
                <ol
                  data-testid="overview-upcoming-list"
                  style={{ ...listStyle, gap: spacingTokens.md }}
                >
                  {groupByDay(schedule.upcoming, (slot) => slot.scheduledAtUtc, timeZone).map(
                    (group) => (
                      <li key={group.day}>
                        <h3
                          style={{
                            margin: `0 0 ${spacingTokens.xs}`,
                            ...typographyTokens.label,
                            color: colorTokens.textSecondary,
                          }}
                        >
                          {dayFormat.format(group.first)}
                        </h3>
                        <ul style={{ ...listStyle, gap: spacingTokens.xs }}>
                          {group.rows.map((slot) => (
                            <li key={slot.id} style={{ ...rowStyle, padding: 0 }}>
                              <time
                                dateTime={slot.scheduledAtUtc.toISOString()}
                                style={{
                                  ...typographyTokens.caption,
                                  color: colorTokens.textMuted,
                                  minInlineSize: '3.5rem',
                                }}
                              >
                                {timeFormat.format(slot.scheduledAtUtc)}
                              </time>
                              <Link
                                href={`/${locale}/content/compose?item=${slot.contentItemId}`}
                                style={{
                                  ...typographyTokens.bodySm,
                                  fontWeight: 600,
                                  flex: '1 1 10rem',
                                  minInlineSize: 0,
                                }}
                              >
                                {slot.item?.title ?? '—'}
                              </Link>
                              <StatusBadge
                                label={t(`home.slot.${slot.status}` as MessageKey)}
                                tone={slot.status === 'PLANNED' ? 'neutral' : 'info'}
                              />
                            </li>
                          ))}
                        </ul>
                      </li>
                    ),
                  )}
                </ol>
              )}
            </Card>
          ) : null}
        </div>

        {/* ------------------------------------------------ E — PERFORMANCE */}
        <section
          aria-labelledby="home-performance-title"
          style={{ display: 'grid', gap: spacingTokens.sm }}
        >
          <h2 id="home-performance-title" style={{ margin: 0, ...typographyTokens.cardTitle }}>
            {t('home.performance.title')}
          </h2>
          <ContentGrid min="10rem" testId="overview-metrics">
            <MetricCard
              label={t('overview.metric.engagement')}
              {...(engagements === null
                ? {
                    unavailable: true,
                    unavailableLabel: maySeeAnalytics
                      ? t('analytics.absent.metrics_pending')
                      : t('overview.metric.hidden'),
                  }
                : { value: number.format(engagements) })}
              hint={t('overview.metric.engagementHint')}
              testId="metric-engagement"
            />
            <MetricCard
              label={t('home.metric.published')}
              value={schedule ? number.format(schedule.published) : undefined}
              unavailable={!schedule}
              unavailableLabel={t('overview.metric.hidden')}
              hint={t('home.metric.publishedHint')}
              testId="metric-published-28d"
            />
            <MetricCard
              label={t('overview.metric.scheduled')}
              value={schedule ? number.format(schedule.upcoming.length) : undefined}
              unavailable={!schedule}
              unavailableLabel={t('overview.metric.hidden')}
              hint={t('home.metric.scheduledHint')}
              testId="metric-scheduled"
            />
            <MetricCard
              label={t('overview.metric.inReview')}
              value={schedule ? number.format(schedule.inReview) : undefined}
              unavailable={!schedule}
              unavailableLabel={t('overview.metric.hidden')}
              hint={
                pendingApprovals === null
                  ? undefined
                  : t('home.metric.approvalsHint').replace(
                      '{count}',
                      number.format(pendingApprovals),
                    )
              }
              testId="metric-in-review"
            />
          </ContentGrid>
        </section>
      </Stack>
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
  alignItems: 'center',
  gap: spacingTokens.sm,
  padding: spacingTokens.sm,
  borderRadius: radiusTokens.md,
  background: colorTokens.surfaceSoft,
} as const;

const actionsStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: spacingTokens.xs,
  alignItems: 'center',
} as const;

const avatarStyle = {
  display: 'inline-grid',
  placeItems: 'center',
  flex: '0 0 auto',
  inlineSize: '2rem',
  blockSize: '2rem',
  borderRadius: radiusTokens.full,
  background: colorTokens.surfaceLavenderStrong,
  color: colorTokens.brandPurplePressed,
  ...typographyTokens.caption,
  fontWeight: 700,
} as const;
