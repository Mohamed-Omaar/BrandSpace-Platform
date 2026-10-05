import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { CopilotLink } from '../../../components/copilot-link';
import { PrototypeHeroCanvas, PrototypeIcon } from '@brandspace/ui';
import { localizedFrom } from '@brandspace/brand-brain';
import { brandIdQueryFilter, mayReadCreditBalance, systemClock } from '@brandspace/shared';
import { dayLabel } from '../../../server/prototype-dates';
import { countPublishedPosts, detectAnomalies } from '@brandspace/analytics';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inContentStudio } from '../../../server/content-context';
import { decidePreferenceAction, decideWorkflowAction } from './actions';
import { inAnalytics } from '../../../server/analytics-context';
import { attentionItems, rankAttention, type AttentionItem } from '../../../server/command-center';
import {
  PERFORMANCE_SHIFT_RECENT_DAYS,
  latestShift,
  performanceShiftItem,
} from '../../../server/performance-patterns';
import {
  HOME_RECOMMENDATIONS,
  RECOMMENDATION_INSIGHT_TYPES,
  attentionAction,
  greetingName,
  greetingPeriod,
  hourIn,
  safeZone,
} from '../../../server/home';
import {
  compactCount,
  deltaText,
  comparableChange,
  homeKindFor,
  setupChecklistFacts,
  sparkPath,
  type HomeKind,
} from '../../../server/home-prototype';
import { mediaForVariants } from '../../../server/media-picker';
import {
  optionalMessage,
  statusMessage,
  translator,
  type MessageKey,
} from '../../../i18n/messages';
import { copilotHref } from '../../../server/copilot-surface';
import { WorkspaceShell } from '../../../components/workspace-shell';
import { reviewIntelligenceAction } from '../intelligence/actions';
import { setupFactsFor } from '../../../server/setup-wizard';
import { setupSteps } from '../../../server/setup-wizard-state';

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
  locale: string,
): string {
  const counted =
    item.detail === undefined && NAMED_OR_COUNTED.has(item.kind)
      ? `attention.${item.kind}.many`
      : `attention.${item.kind}`;
  // D-299 — "1 post failed", not "1 posts failed": a `.one` form where one exists.
  const key =
    item.count === 1 && optionalMessage(locale, `${counted}.one`) !== null
      ? `${counted}.one`
      : counted;
  const detail = item.localizedDetail
    ? // D12 — a configured key question: the reader's language, the other if absent.
      ((locale === 'ar'
        ? (item.localizedDetail.ar ?? item.localizedDetail.en)
        : (item.localizedDetail.en ?? item.localizedDetail.ar)) ?? '')
    : item.detail !== undefined && METRIC_DETAIL.has(item.kind)
      ? t(`analytics.metric.${item.detail}` as never)
      : (item.detail ?? '');
  return t(key as never)
    .replace('{count}', String(item.count))
    .replace('{detail}', detail)
    .replace('{date}', item.date ? formatDate(item.date) : '')
    .replace('{secondDate}', item.secondDate ? formatDate(item.secondDate) : '');
}

/**
 * HOME — PORTED FROM `prototype-2026-09-27` (D-468): `Main.dc.html` lines
 * 192–328, its stylesheet in `@brandspace/ui/prototype.css`.
 *
 * TWO HOMES, as the prototype draws them. The FULL Home for a member who
 * creates and approves — the hero with its three floating cards, the four
 * figures, the setup checklist while setup is unfinished, "Needs you", Upcoming
 * beside the Copilot card, and "BrandSpace noticed". A ROLE Home for everyone
 * else — a greeting card and the two to four sections their role asks for
 * (`homeKindFor`, decided from permissions as A6 decided).
 *
 * NOTHING HERE IS NEW DATA. Every block reads the module that owns it — the
 * Command Center's attention sources, calendar slots, approvals, the analytics
 * queries, the credit wallet, `Insight` rows, the noticed preferences and
 * workflows — under the reader's BrandScope and the rail's brand. Where a
 * figure is unknown it says so ("—"); it never shows a zero standing in for
 * "unknown", and the prototype's own sample content never ships.
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
  const { customer, workspace, messageLocale } = await requireWorkspace(locale);
  const t = translator(messageLocale);
  const fill = (key: MessageKey, values: Record<string, string>): string =>
    Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      t(key),
    );
  const may = (key: string) => workspace.permissionKeys.includes(key);

  const maySeeContent = may('content.read');
  const maySeeAnalytics = may('analytics.read');
  const mayUseCopilot = may('copilot.use');
  const maySeeInsights = may('strategy.read');
  const mayReviewInsights = may('strategy.manage');
  const mayApprove = may('content.approve');
  const mayReadCredits = mayReadCreditBalance(workspace.permissionKeys);
  const kind: HomeKind = homeKindFor(workspace.permissionKeys);

  const brandContext = await brandContextFor(workspace, '/overview');
  const brand = requiredBrand(brandContext);
  const brandId =
    brandContext.resolution.kind === 'brand' ? brandContext.resolution.brand.id : undefined;
  const brandName = brand?.name ?? workspace.workspaceName;
  const now = systemClock.now();
  const DAY = 86_400_000;
  const last28 = { start: new Date(now.getTime() - 28 * DAY), end: now };

  const timeZone = safeZone(
    await inWorkspace(workspace.workspaceId, async ({ db }) =>
      db.workspace
        .findUnique({ where: { id: workspace.workspaceId }, select: { timezone: true } })
        .then((row) => row?.timezone ?? null),
    ),
  );

  /* ------------------------------------------------------------ Needs you */
  const performanceShift = maySeeAnalytics
    ? await inAnalytics(workspace.workspaceId, async (services) => {
        const queries = await services.queries();
        const series = await queries.series({
          scope: {},
          period: last28,
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

  /* ------------------------------------------------------- BrandSpace noticed */
  /*
   * D7 (Phase 2B-2) — Settings → AI switches suggestions off per brand; with
   * it off the "noticed" card is not drawn (the prototype's `x.suggestOn`).
   */
  const suggestionBrands = maySeeInsights
    ? await inWorkspace(workspace.workspaceId, async ({ db }) =>
        db.brand.findMany({
          where: {
            workspaceId: workspace.workspaceId,
            deletedAt: null,
            ...(brandId ? { id: brandId } : {}),
            ...(workspace.brandScope.length > 0
              ? { AND: [{ id: { in: [...workspace.brandScope] } }] }
              : {}),
          },
          select: { id: true, aiSuggestionsEnabled: true },
        }),
      )
    : [];
  const suggestionsOff = suggestionBrands
    .filter((row) => !row.aiSuggestionsEnabled)
    .map((row) => row.id);
  const showRecommendations =
    maySeeInsights &&
    (suggestionBrands.length === 0 || suggestionBrands.some((row) => row.aiSuggestionsEnabled)) &&
    !(brandId && suggestionsOff.includes(brandId));
  const recommendations = showRecommendations
    ? await inWorkspace(workspace.workspaceId, async ({ db }) =>
        db.insight.findMany({
          where: {
            workspaceId: workspace.workspaceId,
            ...brandIdQueryFilter({ brandId, brandScope: workspace.brandScope }),
            ...(suggestionsOff.length > 0 ? { NOT: { brandId: { in: suggestionsOff } } } : {}),
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

  const { noticedPreferences, noticedWorkflows } =
    brandId && may('content.create')
      ? await inContentStudio(workspace.workspaceId, async ({ suggestions }) => {
          const service = await suggestions();
          const scope = { userId: customer.userId, brandId, brandScope: workspace.brandScope };
          return {
            noticedPreferences: (await service.noticedPreferences(scope)).slice(0, 2),
            noticedWorkflows: (await service.noticedWorkflows(scope)).slice(0, 1),
          };
        })
      : { noticedPreferences: [], noticedWorkflows: [] };
  const weekdayName = (day: number) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en', {
      weekday: 'long',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2023, 0, 1 + day)));
  const workflowText = (workflow: (typeof noticedWorkflows)[number], template: MessageKey) =>
    t(template)
      .replace('{language}', t(`home.workflow.language.${workflow.locale}` as MessageKey))
      .replace(
        '{platform}',
        optionalMessage(messageLocale, `content.platform.${workflow.platformKey}`) ??
          workflow.platformKey,
      )
      .replace('{made}', weekdayName(workflow.createdWeekday))
      .replace('{planned}', weekdayName(workflow.slotWeekday))
      .replace('{count}', String(workflow.repeats));

  /* ------------------------------------------------------ the calendar's facts */
  const scope = brandIdQueryFilter({ brandId, brandScope: workspace.brandScope });
  const schedule = maySeeContent
    ? await inWorkspace(workspace.workspaceId, async ({ db }) => {
        const [upcoming, scheduled14, published, channels] = await Promise.all([
          // `upcomingRecs`: the store from now on, the next four.
          db.calendarSlot.findMany({
            where: {
              workspaceId: workspace.workspaceId,
              status: { in: ['PLANNED', 'SCHEDULED', 'PUBLISHING'] },
              ...scope,
              scheduledAtUtc: { gte: now },
            },
            orderBy: { scheduledAtUtc: 'asc' },
            take: 4,
            select: {
              id: true,
              status: true,
              scheduledAtUtc: true,
              platformKeys: true,
              contentItemId: true,
              item: {
                select: {
                  title: true,
                  status: true,
                  variants: { take: 1, select: { assetIds: true, coverAssetId: true } },
                },
              },
            },
          }),
          // `sched14`: scheduled in the next two weeks.
          db.calendarSlot.count({
            where: {
              workspaceId: workspace.workspaceId,
              status: { in: ['SCHEDULED', 'PUBLISHING'] },
              ...scope,
              scheduledAtUtc: { gte: now, lt: new Date(now.getTime() + 14 * DAY) },
            },
          }),
          // F5 — the same live list Performance counts: posts, not per-channel jobs.
          countPublishedPosts(db, {
            workspaceId: workspace.workspaceId,
            brandId,
            brandScope: workspace.brandScope,
            period: last28,
          }),
          db.socialConnection.count({
            where: { workspaceId: workspace.workspaceId, status: 'ACTIVE', ...scope },
          }),
        ]);
        return { upcoming, scheduled14, published, channels };
      })
    : null;

  const pendingApprovals =
    maySeeContent && mayApprove
      ? await inContentStudio(workspace.workspaceId, async ({ approvals }) =>
          (await approvals()).pendingCount(workspace.brandScope),
        )
      : null;

  /* The upcoming rows' pictures: the post's own cover or first attachment. */
  const thumbIds = new Map(
    (schedule?.upcoming ?? []).map((slot) => {
      const variant = slot.item?.variants[0];
      return [slot.id, variant?.coverAssetId ?? variant?.assetIds[0] ?? null] as const;
    }),
  );
  const media = await mediaForVariants({
    workspaceId: workspace.workspaceId,
    userId: customer.userId,
    permissionKeys: workspace.permissionKeys,
    brandScope: workspace.brandScope,
    assetIds: [...thumbIds.values()].filter((id): id is string => id !== null),
  }).catch(() => new Map());
  const thumbFor = (slotId: string): string | null => {
    const id = thumbIds.get(slotId);
    const option = id ? media.get(id) : undefined;
    return option && option.kind === 'IMAGE' && option.previewToken
      ? `/${locale}/assets/file/${option.previewToken}`
      : null;
  };

  /* ------------------------------------------------ Performance · last 28 days */
  const reach = maySeeAnalytics
    ? await inAnalytics(workspace.workspaceId, async (services) => {
        const queries = await services.queries();
        const previous28 = {
          start: new Date(last28.start.getTime() - 28 * DAY),
          end: last28.start,
        };
        const [summary, series, previousSeries] = await Promise.all([
          queries.summary({
            scope: brandId ? { brandId } : {},
            period: last28,
            comparison: previous28,
            brandScope: workspace.brandScope,
            metricKeys: ['reach'],
          }),
          queries.series({
            scope: brandId ? { brandId } : {},
            period: last28,
            metricKey: 'reach',
            brandScope: workspace.brandScope,
          }),
          queries.series({
            scope: brandId ? { brandId } : {},
            period: previous28,
            metricKey: 'reach',
            brandScope: workspace.brandScope,
          }),
        ]);
        const metric = summary.metrics.find((entry) => entry.metricKey === 'reach');
        return {
          value:
            metric?.value === null || metric?.value === undefined ? null : Number(metric.value),
          // Round 4 (4.5): "—" unless the previous 28 days were measured from their first day.
          changeMilli: comparableChange(
            metric?.changeMilli ?? null,
            previousSeries.points.map((point) =>
              point.value === null ? null : Number(point.value),
            ),
          ),
          points: series.points.map((point) => (point.value === null ? null : Number(point.value))),
        };
      }).catch(() => null)
    : null;

  /* ---------------------------------------------------------------- AI credits */
  /*
   * ROUND 4 (4.6) — "n · of N · resets D", AND THE BAR, THE SAME FIGURE AS
   * BILLING. The balance is the ledger service's own `wallet()` — the call
   * Billing's balance reads — so the two can never disagree; N is the plan's
   * monthly grant; D is the wallet's next reset, else the subscription's
   * renewal (or trial end), the date Billing states as "Renews". Nothing is
   * computed that the accounting does not already hold.
   */
  const credits = mayReadCredits
    ? await inWorkspace(workspace.workspaceId, async ({ db, entitlements, credits: ledger }) => {
        const [wallet, row, subscription] = await Promise.all([
          ledger.wallet(workspace.workspaceId),
          db.creditWallet.findUnique({
            where: { workspaceId: workspace.workspaceId },
            select: { nextResetAt: true },
          }),
          db.workspaceSubscription.findUnique({
            where: { workspaceId: workspace.workspaceId },
            select: { status: true, currentPeriodEnd: true, trialEndsAt: true },
          }),
        ]);
        const context = await entitlements.contextFor(workspace.workspaceId).catch(() => null);
        const plan = context?.planKey
          ? (await entitlements.plans().catch(() => [])).find(
              (entry) => entry.key === context.planKey,
            )
          : undefined;
        const renews = subscription
          ? subscription.status === 'TRIALING'
            ? subscription.trialEndsAt
            : subscription.currentPeriodEnd
          : null;
        return {
          balance: wallet.balanceCredits,
          monthly: plan && plan.monthlyCredits > 0 ? plan.monthlyCredits : null,
          resetsAt: row?.nextResetAt ?? renews ?? null,
        };
      }).catch(() => null)
    : null;

  /* ----------------------------------------------------------- setup checklist */
  const setup =
    brandId !== undefined
      ? await inWorkspace(workspace.workspaceId, async ({ db }) =>
          setupChecklistFacts(db, {
            workspaceId: workspace.workspaceId,
            brandId,
            brandScope: workspace.brandScope,
          }),
        ).catch(() => null)
      : null;
  /*
   * Round 3 (C6) — THE PROTOTYPE HIDES THE CHECKLIST ONCE THE BRAND IS SET UP:
   * the setup wizard's brand, teach and accounts steps done (its own truth
   * conditions, `setupSteps`). Until then it is shown as before.
   */
  const brandSetUp =
    brandId !== undefined
      ? await setupFactsFor(workspace.workspaceId, brandId)
          .then((facts) =>
            setupSteps(facts)
              .filter((step) => ['brand', 'learn', 'connect'].includes(step.key))
              .every((step) => step.complete),
          )
          .catch(() => false)
      : false;

  /* ---------------------------------------------------------- the role Homes */
  const roleRows = kind === 'owner' ? null : await roleSections();
  async function roleSections() {
    return inWorkspace(workspace.workspaceId, async ({ db }) => {
      const select = {
        id: true,
        status: true,
        scheduledAtUtc: true,
        platformKeys: true,
        contentItemId: true,
        item: { select: { title: true, status: true } },
      } as const;
      const coming = await db.calendarSlot.findMany({
        where: {
          workspaceId: workspace.workspaceId,
          status: { in: ['PLANNED', 'SCHEDULED'] },
          scheduledAtUtc: { gte: now },
          item: { deletedAt: null },
          ...scope,
        },
        orderBy: { scheduledAtUtc: 'asc' },
        take: 20,
        select,
      });
      const queue =
        kind === 'approver'
          ? (
              await inContentStudio(workspace.workspaceId, async ({ approvals }) =>
                (await approvals()).queue({ brandScope: workspace.brandScope, take: 20 }),
              )
            ).filter((approval) => !brandId || approval.brandId === brandId)
          : [];
      const mine =
        kind === 'creator'
          ? await Promise.all([
              db.contentItem.findMany({
                where: {
                  workspaceId: workspace.workspaceId,
                  deletedAt: null,
                  createdByUserId: customer.userId,
                  status: { in: ['DRAFT', 'CHANGES_REQUESTED'] },
                  ...scope,
                },
                orderBy: { updatedAt: 'desc' },
                take: 20,
                select: { id: true, title: true, status: true },
              }),
              db.approval.findMany({
                where: {
                  workspaceId: workspace.workspaceId,
                  requestedByUserId: customer.userId,
                  status: 'PENDING',
                  ...scope,
                },
                orderBy: { createdAt: 'desc' },
                take: 20,
                select: { id: true, item: { select: { title: true } } },
              }),
              db.calendarSlot.findMany({
                where: {
                  workspaceId: workspace.workspaceId,
                  status: { in: ['PLANNED', 'SCHEDULED'] },
                  scheduledAtUtc: { gte: now },
                  item: { createdByUserId: customer.userId, deletedAt: null },
                  ...scope,
                },
                orderBy: { scheduledAtUtc: 'asc' },
                take: 20,
                select,
              }),
            ])
          : null;
      const top =
        kind === 'analyst'
          ? await inAnalytics(workspace.workspaceId, async (services) =>
              (await services.queries()).topPosts({
                scope: brandId ? { brandId } : {},
                period: last28,
                metricKey: 'reach',
                limit: 4,
                brandScope: workspace.brandScope,
              }),
            ).catch(() => [])
          : [];
      return { coming, queue, mine, top };
    });
  }

  /* -------------------------------------------------------------- formatting */
  const dateIn = (value: Date, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-US', {
      ...options,
      timeZone,
    }).format(value);
  const hhmm = (value: Date) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(value);
  const monthDay = (value: Date) => dateIn(value, { month: 'short', day: 'numeric' });
  const integer = (value: number) => value.toLocaleString('en-US');
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
  const channelNames = (keys: readonly string[]) =>
    keys.map((key) => optionalMessage(messageLocale, `content.platform.${key}`) ?? key).join(' · ');
  const pick = (value: unknown) => {
    const text = localizedFrom(value as never);
    return (locale === 'ar' ? (text.ar ?? text.en) : (text.en ?? text.ar)) ?? '';
  };

  const period = greetingPeriod(hourIn(now, timeZone));
  const firstName = greetingName(customer.name);
  const greeting = firstName
    ? t(`home.greeting.${period}` as MessageKey).replace('{name}', firstName)
    : t(`home.greeting.${period}.plain` as MessageKey);
  const ok = typeof query['ok'] === 'string' ? statusMessage(query['ok'], locale) : null;

  /* `UKS`: the upcoming row's pill — scheduled, in review, a draft. */
  const upcomingPill = (slot: { status: string; item: { status: string } | null }) =>
    slot.status === 'SCHEDULED' || slot.status === 'PUBLISHING'
      ? { cls: 'bsp-pill bsp-p-info', label: t('home.p.upScheduled') }
      : slot.item?.status === 'IN_REVIEW'
        ? { cls: 'bsp-pill bsp-p-warn', label: t('home.p.upInReview') }
        : { cls: 'bsp-pill bsp-p-neu', label: t('home.p.upDraft') };

  /* ------------------------------------------------------- the setup checklist */
  const GLYPH: Record<string, string> = {
    prof: '◇',
    conn: '⌁',
    brain: '✦',
    post: '✎',
    send: '➚',
    team: '◎',
  };
  const steps = setup
    ? [
        { k: 'prof', label: t('home.p.stepProfile'), done: true, ok: true, href: null },
        {
          k: 'conn',
          label: t('home.p.stepConnect'),
          done: setup.connections > 0,
          ok: may('integrations.manage'),
          href: `/${locale}/integrations`,
        },
        {
          k: 'brain',
          label: fill('home.p.stepBrain', {
            done: String(setup.areasComplete),
            total: String(setup.areasTotal),
          }),
          done: setup.brainComplete,
          ok: may('brand_brain.edit'),
          href: `/${locale}/brand-brain`,
        },
        {
          k: 'post',
          label: t('home.p.stepPost'),
          done: setup.hasPost,
          ok: may('content.create'),
          href: `/${locale}/content/compose`,
        },
        {
          k: 'send',
          label: may('content.schedule') ? t('home.p.stepSchedule') : t('home.p.stepSubmit'),
          done: setup.hasSent,
          ok: may('content.schedule') || may('content.submit'),
          href: setup.hasPost ? `/${locale}/content` : `/${locale}/content/compose`,
        },
        {
          k: 'team',
          label: t('home.p.stepTeam'),
          done: setup.members > 1,
          ok: may('member.manage'),
          href: `/${locale}/members`,
        },
      ].filter((step) => step.ok)
    : [];
  const stepsDone = steps.filter((step) => step.done).length;
  const stepsLeft = steps.length - stepsDone;
  const setupCard =
    steps.length > 0 && stepsLeft > 0 && !brandSetUp ? (
      <section className="bsp-card" data-testid="home-setup" style={SETUP_CARD}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <h2 className="bsp-sech">{fill('home.p.setupTitle', { brand: brandName })}</h2>
            <span style={{ fontSize: 'var(--bsp-t-13)', color: 'var(--bs-text-muted)' }}>
              {stepsLeft === 1
                ? t('home.p.setupLeftOne')
                : fill('home.p.setupLeft', { count: String(stepsLeft) })}
            </span>
          </div>
          <span
            className="bsp-ltr"
            style={{
              fontSize: 'var(--bsp-t-22)',
              fontWeight: 800,
              color: 'var(--bs-brand-purple-pressed)',
            }}
          >
            {stepsDone}/{steps.length}
          </span>
        </div>
        <div className="bsp-bar" style={{ height: '6px' }}>
          <span style={{ width: `${Math.round((stepsDone / steps.length) * 100)}%` }} />
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: '10px',
          }}
        >
          {steps.map((step) => (
            <div
              key={step.k}
              className="bsp-xcard"
              data-testid={`home-setup-${step.k}`}
              data-done={step.done ? 'true' : 'false'}
              style={{
                background: step.done ? 'var(--bsp-setup-done)' : 'var(--bsp-setup-todo)',
                boxShadow: 'none',
                padding: '18px',
                minHeight: '150px',
                // A <div> in the prototype, which has no box-sizing reset.
                boxSizing: 'content-box',
              }}
            >
              <span
                className="bsp-xicon"
                aria-hidden="true"
                style={
                  step.done
                    ? { background: 'var(--bsp-ok-tint)', color: 'var(--bsp-ok-ink)' }
                    : undefined
                }
              >
                {step.done ? '✓' : GLYPH[step.k]}
              </span>
              <span
                className="bsp-xtitle bsp-sm"
                style={{ color: step.done ? 'var(--bs-text-muted)' : 'var(--bs-text-primary)' }}
              >
                {step.label}
              </span>
              {!step.done && step.href ? (
                <Link
                  href={step.href}
                  className="bsp-btn bsp-sm"
                  style={{ alignSelf: 'flex-start', marginTop: 'auto' }}
                >
                  {t('home.p.stepGo')}
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    ) : null;

  /*
   * NEEDS YOU (Main.dc.html lines 230–244). The owner's Home always draws it;
   * a role Home draws it only when it has rows — D12 (a recorded owner
   * decision, kept under D-468 (a)) gives a copywriter the Brand Brain rows.
   */
  const needsYouCard = (
    <section className="bsp-card" data-testid="attention-card" style={{ overflow: 'hidden' }}>
      <div style={NEEDS_HEAD}>
        <h2 className="bsp-sech">{t('home.p.needsTitle')}</h2>
        <span style={{ fontSize: 'var(--bsp-t-12_5)', color: 'var(--bs-text-muted)' }}>
          {fill('home.p.needsScope', { brand: brandName })}
        </span>
      </div>
      {attention.length === 0 ? (
        <div className="bsp-row" data-testid="attention-none">
          <span className="bsp-pill bsp-p-ok">{t('home.p.allClear')}</span>
          <span style={{ fontSize: 'var(--bsp-t-14)', color: 'var(--bs-text-secondary)' }}>
            {t('home.p.allClearSub')}
          </span>
        </div>
      ) : (
        <ul data-testid="attention-list" style={LIST}>
          {attention.map((item) => {
            const tag = TAG[item.kind] ?? (item.severity === 'blocked' ? 'failed' : 'change');
            return (
              <li key={item.kind} className="bsp-row" data-testid={`attention-${item.kind}`}>
                <span className={`bsp-pill ${TAG_TONE[tag]}`}>
                  {t(`home.p.tag.${tag}` as MessageKey)}
                </span>
                <span style={{ flexGrow: 1, fontSize: 'var(--bsp-t-14)', fontWeight: 600 }}>
                  {attentionSentence(
                    t as never,
                    item,
                    (value) => dayLabel(value, locale, timeZone, now),
                    locale,
                  )}
                </span>
                <Link
                  href={`/${locale}${item.href}`}
                  className="bsp-btn bsp-sm bsp-sec"
                  data-testid={`attention-action-${item.kind}`}
                >
                  {t(
                    `home.action.${attentionAction(item.kind, workspace.permissionKeys)}` as MessageKey,
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      activePath="/overview"
      heading={t('overview.greeting')}
      description={fill('home.p.description', { brand: brandName })}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {ok ? (
        <p role="status" style={{ margin: 0, fontSize: 'var(--bsp-t-13_5)' }}>
          {ok}
        </p>
      ) : null}
      {kind === 'owner' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
          {/* ------------------------------------------------------------ the hero */}
          <section className="bsp-hero" data-testid="overview-hero">
            <PrototypeHeroCanvas className="bsp-hero-canvas" />
            <div className="bsp-hero-copy">
              <span className="bsp-pill bsp-hero-brand" data-testid="hero-brand">
                <bdi>{brandName}</bdi>
              </span>
              <p className="bsp-hero-greet" data-testid="hero-greeting">
                {greeting}
              </p>
              <p className="bsp-hero-sub">{fill('home.p.heroSub', { brand: brandName })}</p>
              <div className="bsp-hero-actions">
                {may('content.create') ? (
                  <Link
                    href={`/${locale}/content/compose`}
                    className="bsp-btn"
                    data-testid="hero-primary"
                  >
                    <PrototypeIcon glyph="plus" size={16} stroke={2.25} />
                    {t('home.p.newPost')}
                  </Link>
                ) : null}
                {mayUseCopilot ? (
                  <CopilotLink
                    href={copilotHref(locale, 'overview')}
                    className="bsp-btn bsp-ghost"
                    data-testid="overview-copilot-open"
                  >
                    {t('home.hero.copilot')} <span aria-hidden="true">→</span>
                  </CopilotLink>
                ) : null}
              </div>
            </div>
            <div className="bsp-float bsp-float-perf" data-testid="hero-performance">
              <span className="bsp-float-title">{t('home.p.perfTitle')}</span>
              {maySeeAnalytics ? (
                <span className="bsp-float-line" data-testid="metric-engagement">
                  <span
                    className="bsp-ltr"
                    style={{ fontWeight: 800, color: 'var(--bs-text-primary)' }}
                  >
                    {reach?.value === null || reach === null ? '—' : compactCount(reach.value)}
                  </span>{' '}
                  {t('home.p.reach')}{' '}
                  {reach && reach.value !== null
                    ? (() => {
                        const delta = deltaText(reach.changeMilli);
                        return (
                          <span
                            className="bsp-ltr"
                            style={{
                              fontWeight: 800,
                              color:
                                delta.tone === 'up'
                                  ? 'var(--bs-success)'
                                  : delta.tone === 'down'
                                    ? 'var(--bs-danger)'
                                    : 'var(--bsp-faint)',
                            }}
                          >
                            {delta.text}
                          </span>
                        );
                      })()
                    : null}
                </span>
              ) : (
                <span className="bsp-float-line" data-testid="metric-engagement">
                  {t('overview.metric.hidden')}
                </span>
              )}
              <svg
                viewBox="0 0 120 30"
                width="100%"
                height="54"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path
                  d={sparkPath(reach?.points ?? [])}
                  fill="none"
                  stroke="var(--bs-brand-purple)"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="bsp-float bsp-float-next" data-testid="hero-next">
              <span className="bsp-float-thumb" aria-hidden="true">
                {schedule?.upcoming[0] && thumbFor(schedule.upcoming[0].id) ? (
                  <img src={thumbFor(schedule.upcoming[0].id) ?? ''} alt="" />
                ) : null}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                <span className="bsp-float-title">{t('overview.float.next')}</span>
                <span className="bsp-float-detail">
                  {schedule?.upcoming[0]
                    ? [
                        schedule.upcoming[0].item?.title ?? '—',
                        monthDay(schedule.upcoming[0].scheduledAtUtc),
                        hhmm(schedule.upcoming[0].scheduledAtUtc),
                      ].join(' · ')
                    : t('overview.upcomingEmptyTitle')}
                </span>
              </span>
            </div>
            {pendingApprovals !== null ? (
              <Link
                href={`/${locale}/approvals`}
                className="bsp-float-approvals"
                data-testid="hero-approvals"
              >
                <span className="bsp-float-approvals-count bsp-ltr">
                  {integer(pendingApprovals)}
                </span>
                {t('home.p.waitingApproval')}
              </Link>
            ) : null}
          </section>

          {/* ----------------------------------------------------- the four figures */}
          <div
            className="bsp-xgrid bsp-home-kpis"
            data-testid="overview-metrics"
            style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}
          >
            <Figure
              testId="metric-scheduled"
              href={`/${locale}/calendar`}
              glyph="▦"
              value={schedule ? pad(schedule.scheduled14) : '—'}
              label={t('home.p.kSched')}
              sub={schedule ? t('home.p.kSchedSub') : t('overview.metric.hidden')}
              delay="0s"
            />
            <Figure
              testId="metric-in-review"
              href={`/${locale}/approvals`}
              glyph="✓"
              value={pendingApprovals === null ? '—' : pad(pendingApprovals)}
              label={t('home.p.kWaiting')}
              sub={
                pendingApprovals === null
                  ? t('overview.metric.hidden')
                  : pendingApprovals > 0
                    ? t('home.p.kWaitingSub')
                    : t('home.p.kWaitingClear')
              }
              subColor={
                pendingApprovals === null
                  ? undefined
                  : pendingApprovals > 0
                    ? 'var(--bsp-warn-ink)'
                    : 'var(--bs-success)'
              }
              delay=".08s"
            />
            <Figure
              testId="metric-published-28d"
              href={`/${locale}/analytics`}
              glyph="↗"
              value={schedule ? pad(schedule.published) : '—'}
              label={t('home.p.kPub')}
              sub={
                schedule
                  ? fill('home.p.kPubSub', { count: String(schedule.channels) })
                  : t('overview.metric.hidden')
              }
              delay=".16s"
            />
            {credits ? (
              <Figure
                testId="metric-credits"
                href={may('billing.read') ? `/${locale}/billing` : undefined}
                glyph="✦"
                value={integer(credits.balance)}
                label={t('home.p.kCred')}
                sub={
                  credits.monthly !== null && credits.resetsAt
                    ? fill('home.p.kCredSub', {
                        total: integer(credits.monthly),
                        date: dayLabel(credits.resetsAt, locale, timeZone, now),
                      })
                    : credits.monthly !== null
                      ? fill('home.p.kCredSubTotal', { total: integer(credits.monthly) })
                      : credits.resetsAt
                        ? fill('home.p.kCredSubReset', {
                            date: dayLabel(credits.resetsAt, locale, timeZone, now),
                          })
                        : ''
                }
                bar={
                  credits.monthly !== null
                    ? `${Math.min(100, Math.round((credits.balance / credits.monthly) * 100))}%`
                    : undefined
                }
                delay=".24s"
              />
            ) : (
              <Figure
                testId="metric-credits"
                glyph="✦"
                value="—"
                label={t('home.p.kCred')}
                sub={t('overview.metric.hidden')}
                delay=".24s"
              />
            )}
          </div>

          {setupCard}

          {/* ------------------------------------------------------------ Needs you */}
          {needsYouCard}

          {/* ------------------------------------------- Upcoming, and the Copilot */}
          <div className="bsp-home-split" style={SPLIT}>
            {schedule ? (
              <section className="bsp-card" data-testid="overview-upcoming" style={UPCOMING}>
                <div style={UPCOMING_HEAD}>
                  <span className="bsp-lbl">{t('home.p.upcoming')}</span>
                  <Link
                    href={`/${locale}/calendar`}
                    className="bsp-btn bsp-sm bsp-ghost"
                    data-testid="overview-upcoming-calendar"
                  >
                    {t('home.p.viewAll')} <span aria-hidden="true">→</span>
                  </Link>
                </div>
                {schedule.upcoming.length === 0 ? (
                  <span style={EMPTY_ROW} data-testid="overview-upcoming-empty">
                    {t('home.p.upEmpty')}
                  </span>
                ) : (
                  <ol data-testid="overview-upcoming-list" style={LIST}>
                    {schedule.upcoming.map((slot) => {
                      const pill = upcomingPill(slot);
                      const thumb = thumbFor(slot.id);
                      return (
                        <li key={slot.id}>
                          <Link
                            href={`/${locale}/content/compose?item=${slot.contentItemId}`}
                            className="bsp-uprow"
                            style={UPROW}
                          >
                            <span style={DAY_COL}>
                              <span style={DOW}>
                                {dateIn(slot.scheduledAtUtc, { weekday: 'short' }).toUpperCase()}
                              </span>
                              <span className="bsp-ltr" style={DAYNUM}>
                                {dateIn(slot.scheduledAtUtc, { day: 'numeric' })}
                              </span>
                            </span>
                            <span style={ART} aria-hidden="true">
                              {thumb ? <img src={thumb} alt="" style={ART_IMG} /> : null}
                            </span>
                            <span style={ROW_TEXT}>
                              <span style={ROW_TITLE}>{slot.item?.title ?? '—'}</span>
                              <span style={ROW_META}>
                                {[channelNames(slot.platformKeys), hhmm(slot.scheduledAtUtc)]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                            </span>
                            <span className={pill.cls}>{pill.label}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            ) : null}
            {mayUseCopilot ? (
              <section className="bsp-copilot-card" data-testid="home-copilot">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '10px',
                  }}
                >
                  <span
                    style={{
                      fontSize: 'var(--bsp-t-22)',
                      fontWeight: 800,
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {t('home.p.copilot')}
                  </span>
                  <span className="bsp-pill bsp-ai-pill">
                    <PrototypeIcon glyph="spark" size={12} stroke={0} />
                    {t('home.p.aiSuggestion')}
                  </span>
                </div>
                <span style={{ fontSize: 'var(--bsp-t-14)', color: 'var(--bsp-sub)' }}>
                  {t('home.p.cpCardTitle')}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {(['home.p.sug1', 'home.p.sug2', 'home.p.sug3'] as const).map((key) => (
                    <CopilotLink
                      key={key}
                      href={copilotHref(locale, 'overview')}
                      request={t(key)}
                      className="bsp-copilot-ask"
                      testId={`home-copilot-${key.slice(-4)}`}
                    >
                      {t(key)}
                      <span
                        aria-hidden="true"
                        style={{
                          marginInlineStart: 'auto',
                          color: 'var(--bs-brand-purple-pressed)',
                        }}
                      >
                        →
                      </span>
                    </CopilotLink>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          {/* --------------------------------------------------- BrandSpace noticed */}
          {/* `x.suggestOn` draws the section; D7 keeps the workflow and
              preference cards when only the recommendations are switched off. */}
          {showRecommendations || noticedPreferences.length > 0 || noticedWorkflows.length > 0 ? (
            <section
              className="bsp-card"
              data-testid="home-recommended"
              style={{ overflow: 'hidden' }}
            >
              <div style={{ ...NEEDS_HEAD, padding: '18px 20px 6px' }}>
                <h2 className="bsp-sech">{t('home.p.noticedTitle')}</h2>
                <span style={{ fontSize: 'var(--bsp-t-12_5)', color: 'var(--bs-text-muted)' }}>
                  {t('home.p.noticedScope')}
                </span>
              </div>
              <div className="bsp-home-noticed" style={NOTICED_GRID}>
                {noticedPreferences.map((preference) =>
                  brandId ? (
                    <div
                      key={preference.key}
                      className="bsp-xcard"
                      data-testid={`home-preference-${preference.key}`}
                      style={NOTICED_CARD}
                    >
                      <NoticedHead
                        glyph="✎"
                        tag={t('home.p.tagPreference')}
                        cls="bsp-xstatus bsp-ai"
                      />
                      <span className="bsp-xtitle" style={NOTICED_TITLE}>
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
                          optionalMessage(
                            messageLocale,
                            `content.platform.${preference.platformKey}`,
                          ) ?? preference.platformKey,
                        )}
                      </span>
                      <span className="bsp-xdesc">
                        {t('home.preference.evidence')
                          .replace('{count}', String(preference.observations))
                          .replace('{posts}', String(preference.posts))}
                      </span>
                      <div className="bsp-xfoot" style={NOTICED_FOOT}>
                        {(['accept', 'snooze', 'dismiss'] as const).map((decision) => (
                          <form key={decision} action={decidePreferenceAction}>
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="brandId" value={brandId} />
                            <input type="hidden" name="key" value={preference.key} />
                            <input type="hidden" name="decision" value={decision} />
                            <button
                              type="submit"
                              className={`bsp-btn bsp-sm ${DECISION_CLASS[decision]}`}
                              data-testid={`home-preference-${decision}-${preference.key}`}
                            >
                              {t(`home.preference.${decision}` as MessageKey)}
                            </button>
                          </form>
                        ))}
                      </div>
                    </div>
                  ) : null,
                )}
                {noticedWorkflows.map((workflow) =>
                  brandId ? (
                    <div
                      key={workflow.key}
                      className="bsp-xcard"
                      data-testid={`home-workflow-${workflow.key}`}
                      style={NOTICED_CARD}
                    >
                      <NoticedHead
                        glyph="↻"
                        tag={t('home.p.tagPattern')}
                        cls="bsp-xstatus bsp-info"
                      />
                      <span className="bsp-xtitle" style={NOTICED_TITLE}>
                        {workflowText(workflow, 'home.workflow.sentence')}
                      </span>
                      <span className="bsp-xdesc">{t('home.p.patternEvidence')}</span>
                      <div className="bsp-xfoot" style={NOTICED_FOOT}>
                        {mayUseCopilot ? (
                          <CopilotLink
                            href={copilotHref(locale, 'overview')}
                            request={workflowText(workflow, 'home.workflow.request')}
                            className="bsp-btn bsp-sm bsp-pur"
                            testId={`home-workflow-copilot-${workflow.key}`}
                          >
                            {t('home.p.automateIt')}
                          </CopilotLink>
                        ) : null}
                        {(['snooze', 'dismiss'] as const).map((decision) => (
                          <form key={decision} action={decideWorkflowAction}>
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="brandId" value={brandId} />
                            <input type="hidden" name="key" value={workflow.key} />
                            <input type="hidden" name="decision" value={decision} />
                            <button
                              type="submit"
                              className={`bsp-btn bsp-sm ${DECISION_CLASS[decision]}`}
                              data-testid={`home-workflow-${decision}-${workflow.key}`}
                            >
                              {t(`home.preference.${decision}` as MessageKey)}
                            </button>
                          </form>
                        ))}
                      </div>
                    </div>
                  ) : null,
                )}
                {showRecommendations
                  ? recommendations.map((insight) => (
                      <div
                        key={insight.id}
                        className="bsp-xcard"
                        data-testid={`home-recommendation-${insight.id}`}
                        style={NOTICED_CARD}
                      >
                        <NoticedHead glyph="↗" tag={t('home.p.tagSuggestion')} cls="bsp-xstatus" />
                        <span className="bsp-xtitle" style={NOTICED_TITLE}>
                          {pick(insight.title)}
                        </span>
                        <span className="bsp-xdesc">
                          {t('home.recommended.evidence')
                            .replace('{count}', String(insight._count.evidence))
                            .replace('{basis}', t(`home.basis.${insight.basis}` as MessageKey))}
                        </span>
                        <div className="bsp-xfoot" style={NOTICED_FOOT}>
                          <Link
                            href={`/${locale}/intelligence?insight=${insight.id}`}
                            className="bsp-btn bsp-sm bsp-pur"
                            data-testid={`home-recommendation-evidence-${insight.id}`}
                          >
                            {t('home.recommended.viewEvidence')}
                          </Link>
                          {mayUseCopilot ? (
                            <CopilotLink
                              href={copilotHref(locale, 'intelligence')}
                              className="bsp-btn bsp-sm bsp-sec"
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
                                className="bsp-btn bsp-sm bsp-ghost"
                                data-testid={`home-recommendation-dismiss-${insight.id}`}
                              >
                                {t('insights.dismiss')}
                              </button>
                            </form>
                          ) : null}
                        </div>
                      </div>
                    ))
                  : null}
                {noticedPreferences.length === 0 &&
                noticedWorkflows.length === 0 &&
                recommendations.length === 0 ? (
                  // Not drawn by the prototype (its sample always has three): a
                  // new workspace has nothing to notice yet, said in one line.
                  <p data-testid="home-recommended-none" style={NOTICED_NONE}>
                    {t('home.recommended.none')}
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      ) : (
        /* ---------------------------------------------------------- a role Home */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
          {setupCard}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <section style={ROLE_HERO} data-testid="home-role-hero">
              <span style={ROLE_AVATAR} aria-hidden="true">
                {(firstName ?? customer.email).slice(0, 2).toUpperCase()}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flexGrow: 1 }}>
                <span className="bsp-role-hi">
                  {firstName ? fill('home.p.hi', { name: firstName }) : greeting}
                </span>
                <span style={{ fontSize: 'var(--bsp-t-14_5)', color: 'var(--bs-text-secondary)' }}>
                  {t(`home.p.sub.${kind}` as MessageKey)}
                </span>
              </div>
              <span
                className="bsp-pill"
                style={{
                  background: 'var(--bs-surface)',
                  color: 'var(--bs-text-primary)',
                  padding: '6px 12px',
                }}
              >
                {locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
              </span>
            </section>
            {attention.length > 0 ? needsYouCard : null}
            <div className="bsp-home-noticed" style={ROLE_GRID}>
              {roleRows ? roleSectionsFor(kind, roleRows) : null}
            </div>
          </div>
        </div>
      )}
    </WorkspaceShell>
  );

  /* The role Home's sections (`VA_secs`), each a card of up to four rows. */
  function roleSectionsFor(homeKind: HomeKind, rows: NonNullable<typeof roleRows>): ReactNode {
    const slotRow = (slot: (typeof rows.coming)[number], href: string) => {
      const pill =
        slot.status === 'SCHEDULED'
          ? { cls: 'bsp-xstatus bsp-info', label: t('home.p.upScheduled') }
          : slot.item?.status === 'IN_REVIEW'
            ? { cls: 'bsp-xstatus bsp-warn', label: t('home.p.upInReview') }
            : { cls: 'bsp-xstatus bsp-neu', label: t('home.p.upDraft') };
      return {
        key: slot.id,
        title: slot.item?.title ?? '—',
        meta: [
          channelNames(slot.platformKeys),
          monthDay(slot.scheduledAtUtc),
          hhmm(slot.scheduledAtUtc),
        ]
          .filter(Boolean)
          .join(' · '),
        pill,
        href,
      };
    };
    const up = {
      key: 'up',
      testId: 'home-coming-up',
      title: t('home.p.s.up'),
      sub: t('home.p.s.upSub'),
      cta: { label: t('nav.calendar'), href: `/${locale}/calendar` },
      rows: rows.coming.map((slot) => slotRow(slot, `/${locale}/calendar`)),
    };
    const sections =
      homeKind === 'approver'
        ? [
            {
              key: 'queue',
              testId: 'home-review-queue',
              title: t('home.p.s.queue'),
              sub: t('home.p.s.queueSub'),
              cta: { label: t('nav.approvals'), href: `/${locale}/approvals` },
              rows: rows.queue.map((approval) => ({
                key: approval.id,
                title: approval.item?.title ?? '—',
                meta: '',
                pill: { cls: 'bsp-xstatus bsp-warn', label: t('home.p.upInReview') },
                href: `/${locale}/approvals?review=${approval.id}`,
              })),
            },
            up,
          ]
        : homeKind === 'creator' && rows.mine
          ? [
              {
                key: 'drafts',
                testId: 'home-my-drafts',
                title: t('home.p.s.drafts'),
                sub: t('home.p.s.draftsSub'),
                cta: { label: t('nav.rail.posts'), href: `/${locale}/content` },
                rows: rows.mine[0].map((item) => ({
                  key: item.id,
                  title: item.title,
                  meta: '',
                  pill: { cls: 'bsp-xstatus bsp-neu', label: t('home.p.upDraft') },
                  href: `/${locale}/content/compose?item=${item.id}`,
                })),
              },
              {
                key: 'sent',
                testId: 'home-my-sent',
                title: t('home.p.s.sent'),
                sub: t('home.p.s.sentSub'),
                cta: null,
                rows: rows.mine[1].map((approval) => ({
                  key: approval.id,
                  title: approval.item?.title ?? '—',
                  meta: '',
                  pill: { cls: 'bsp-xstatus bsp-warn', label: t('home.p.upInReview') },
                  href: `/${locale}/approvals`,
                })),
              },
              {
                key: 'mineSched',
                testId: 'home-my-scheduled',
                title: t('home.p.s.mineSched'),
                sub: t('home.p.s.mineSchedSub'),
                cta: null,
                rows: rows.mine[2].map((slot) =>
                  slotRow(slot, `/${locale}/calendar?item=${slot.contentItemId}`),
                ),
              },
              up,
            ]
          : homeKind === 'analyst'
            ? [
                {
                  key: 'top',
                  testId: 'home-top-posts',
                  title: t('home.p.s.top'),
                  sub: t('home.p.s.topSub'),
                  cta: { label: t('nav.rail.performance'), href: `/${locale}/analytics` },
                  rows: rows.top.map((post) => ({
                    key: `${post.contentItemId}-${post.provider}`,
                    title: post.title ?? '—',
                    meta: `${compactCount(Number(post.value))} ${t('home.p.reach')}`,
                    pill: { cls: 'bsp-xstatus', label: t('home.p.s.published') },
                    href: `/${locale}/analytics`,
                  })),
                },
                up,
              ]
            : [
                {
                  key: 'fb',
                  testId: 'home-feedback',
                  title: t('home.p.s.fb'),
                  sub: t('home.p.s.fbSub'),
                  cta: {
                    label: t('nav.calendar'),
                    href: `/${locale}/calendar`,
                    testId: 'home-feedback-calendar',
                  },
                  rows: rows.coming.map((slot) => slotRow(slot, `/${locale}/calendar`)),
                },
                up,
              ];
    return sections.map((section) => (
      <section
        key={section.key}
        className="bsp-card"
        data-testid={section.testId}
        style={ROLE_CARD}
      >
        <div style={ROLE_CARD_HEAD}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: 'var(--bsp-t-15)',
                fontWeight: 800,
              }}
            >
              {section.title}
              <span className="bsp-ltr" style={COUNT_CHIP}>
                {section.rows.length}
              </span>
            </span>
            <span style={{ fontSize: 'var(--bsp-t-12)', color: 'var(--bs-text-muted)' }}>
              {section.sub}
            </span>
          </span>
          {section.cta ? (
            <Link
              href={section.cta.href}
              className="bsp-btn bsp-sm bsp-ghost"
              {...('testId' in section.cta ? { 'data-testid': section.cta.testId } : {})}
            >
              {section.cta.label} <span aria-hidden="true">→</span>
            </Link>
          ) : null}
        </div>
        {section.rows.length === 0 ? (
          <span style={EMPTY_ROW}>{t('home.p.s.empty')}</span>
        ) : (
          <ul style={LIST}>
            {section.rows.slice(0, 4).map((row) => (
              <li key={row.key}>
                <Link href={row.href} className="bsp-uprow" style={{ ...UPROW, gap: '12px' }}>
                  <span style={ART} aria-hidden="true" />
                  <span style={ROW_TEXT}>
                    <span style={ROW_TITLE}>{row.title}</span>
                    {row.meta ? <span style={ROW_META}>{row.meta}</span> : null}
                  </span>
                  <span className={row.pill.cls}>{row.pill.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    ));
  }
}

/** One of the four figures (`.xcard`): the glyph tile, the number, the label, the line. */
function Figure({
  testId,
  href,
  glyph,
  value,
  label,
  sub,
  subColor,
  bar,
  delay,
}: {
  readonly testId: string;
  readonly href?: string | undefined;
  readonly glyph: string;
  readonly value: string;
  readonly label: string;
  readonly sub: string;
  readonly subColor?: string | undefined;
  readonly bar?: string | undefined;
  readonly delay: string;
}) {
  const body = (
    <>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="bsp-xicon" aria-hidden="true">
          {glyph}
        </span>
        <span className="bsp-ltr bsp-xnum" data-testid={`${testId}-value`}>
          {value}
        </span>
      </span>
      <span className="bsp-xtitle">{label}</span>
      <span className="bsp-xdesc" style={subColor ? { color: subColor } : undefined}>
        {sub}
      </span>
      {bar ? (
        <span className="bsp-bar" style={{ height: '5px', marginTop: '6px' }}>
          <span style={{ width: bar }} />
        </span>
      ) : null}
    </>
  );
  const style: CSSProperties = { minHeight: '176px', animationDelay: delay };
  return href ? (
    <Link href={href} className="bsp-xcard bsp-kpi" data-testid={testId} style={style}>
      {body}
    </Link>
  ) : (
    <div className="bsp-xcard bsp-kpi" data-testid={testId} style={style}>
      {body}
    </div>
  );
}

function NoticedHead({ glyph, tag, cls }: { glyph: string; tag: string; cls: string }) {
  return (
    <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span className="bsp-xicon" aria-hidden="true">
        {glyph}
      </span>
      <span className={cls}>{tag}</span>
    </span>
  );
}

/** Which of the prototype's tags an attention row wears. */
const TAG: Readonly<Record<string, string>> = {
  'publishing-failed': 'failed',
  'schedule-overdue': 'failed',
  'content-in-review': 'review',
  'automations-waiting': 'automation',
  'brand-brain-review-waiting': 'brandBrain',
  'brand-brain-missing': 'brandBrain',
  'brand-brain-empty': 'brandBrain',
  'brand-brain-fact-changed': 'brandBrain',
  'learnings-pending': 'brandBrain',
  'insights-new': 'change',
  'performance-above': 'change',
  'performance-below': 'change',
  'notes-mentions': 'notes',
  'notes-assigned': 'notes',
  'calendar-gap': 'plan',
  'campaign-empty': 'plan',
  'connection-reauth': 'accounts',
  'connection-expiring': 'accounts',
  'credits-forecast': 'credits',
};

const TAG_TONE: Readonly<Record<string, string>> = {
  failed: 'bsp-p-bad',
  review: 'bsp-p-warn',
  automation: 'bsp-p-warn',
  brandBrain: 'bsp-p-ai',
  change: 'bsp-p-info',
  notes: 'bsp-p-ai',
  plan: 'bsp-p-neu',
  accounts: 'bsp-p-bad',
  credits: 'bsp-p-warn',
};

const DECISION_CLASS = { accept: 'bsp-pur', snooze: 'bsp-sec', dismiss: 'bsp-ghost' } as const;

/* The prototype's inline geometry, transcribed. */
const LIST: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const SETUP_CARD: CSSProperties = {
  padding: '20px 22px',
  display: 'flex',
  flexDirection: 'column',
  gap: '14px',
};
const NEEDS_HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  padding: '18px 20px 8px',
};
const SPLIT: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)',
  gap: '14px',
  alignItems: 'stretch',
};
const UPCOMING: CSSProperties = {
  padding: '20px 22px',
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  borderRadius: '24px',
};
const UPCOMING_HEAD: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  marginBottom: '8px',
};
const UPROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '14px',
  borderTop: '1px solid var(--bsp-rule)',
  background: 'transparent',
  padding: '10px 6px',
  textAlign: 'start',
  width: '100%',
  borderRadius: '12px',
  color: 'inherit',
  textDecoration: 'none',
  boxSizing: 'border-box',
};
const DAY_COL: CSSProperties = {
  width: '34px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  flexShrink: 0,
};
const DOW: CSSProperties = {
  fontSize: 'var(--bsp-t-10)',
  fontWeight: 600,
  color: 'var(--bsp-faint)',
  letterSpacing: '.04em',
};
const DAYNUM: CSSProperties = {
  fontSize: 'var(--bsp-t-16)',
  fontWeight: 700,
  color: 'var(--bsp-ink-2)',
  lineHeight: 1.2,
};
const ART: CSSProperties = {
  width: '36px',
  height: '36px',
  borderRadius: '10px',
  background: 'var(--bsp-art-empty)',
  flexShrink: 0,
  opacity: 0.9,
  overflow: 'hidden',
};
const ART_IMG: CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};
const ROW_TEXT: CSSProperties = {
  flexGrow: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
};
const ROW_TITLE: CSSProperties = {
  fontSize: 'var(--bsp-t-13_5)',
  fontWeight: 600,
  color: 'var(--bsp-ink-2)',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
};
const ROW_META: CSSProperties = { fontSize: 'var(--bsp-t-12)', color: 'var(--bsp-faint)' };
const EMPTY_ROW: CSSProperties = {
  fontSize: 'var(--bsp-t-13)',
  color: 'var(--bsp-faint)',
  padding: '14px 6px',
  borderTop: '1px solid var(--bsp-rule)',
};
const NOTICED_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '12px',
  padding: '8px 20px 20px',
};
const NOTICED_CARD: CSSProperties = {
  background: 'var(--bsp-noticed)',
  boxShadow: 'none',
  minHeight: '220px',
  // A <div> in the prototype, which has no box-sizing reset.
  boxSizing: 'content-box',
};
const NOTICED_TITLE: CSSProperties = {
  fontSize: 'var(--bsp-t-15)',
  letterSpacing: '-0.01em',
  lineHeight: 1.4,
};
const NOTICED_NONE: CSSProperties = {
  gridColumn: '1 / -1',
  margin: 0,
  padding: '6px 0',
  fontSize: 'var(--bsp-t-13)',
  color: 'var(--bsp-faint)',
};
const NOTICED_FOOT: CSSProperties = { justifyContent: 'flex-start', flexWrap: 'wrap' };
const ROLE_HERO: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  borderRadius: '28px',
  padding: '30px 36px',
  background: 'var(--bsp-role-hero)',
  display: 'flex',
  alignItems: 'center',
  gap: '20px',
};
const ROLE_AVATAR: CSSProperties = {
  width: '56px',
  height: '56px',
  borderRadius: '18px',
  background: 'var(--bs-brand-purple)',
  color: 'var(--bs-surface)',
  display: 'grid',
  placeItems: 'center',
  fontSize: 'var(--bsp-t-18)',
  fontWeight: 800,
  flexShrink: 0,
};
const ROLE_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '14px',
};
const ROLE_CARD: CSSProperties = {
  padding: '18px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  borderRadius: '22px',
};
const ROLE_CARD_HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '10px',
  marginBottom: '8px',
};
const COUNT_CHIP: CSSProperties = {
  fontSize: 'var(--bsp-t-11)',
  fontWeight: 700,
  color: 'var(--bs-text-muted)',
  background: 'var(--bsp-chip)',
  borderRadius: '99px',
  padding: '1px 7px',
};
