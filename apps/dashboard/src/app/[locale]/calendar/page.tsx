import {
  DEFAULT_POST_TIME,
  RESCHEDULABLE_SLOT_STATUSES,
  calendarMarkers,
  formatLocalTime,
  nextDayKey,
  partsInZone,
  suggestedPostingTimes,
} from '@brandspace/content';
import { TenantOnboardingPolicySource, industryKeyFor } from '@brandspace/onboarding';
import { QUOTA_FEATURES } from '@brandspace/entitlements';
import { systemClock } from '@brandspace/shared';
import type {
  ApprovalStatus,
  CalendarDay,
  PostRecord,
  PostStatus,
  SocialPlatform,
} from '@brandspace/ui';
import { currentEnvironment, requireWorkspacePage } from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { brandContextFor } from '../../../server/brand-context';
import { inContentStudio } from '../../../server/content-context';
import { inSocial } from '../../../server/social-context';
import { isBlocking, needsAttention, publishReadiness } from '../../../server/publish-readiness';
import { mediaForVariants } from '../../../server/media-picker';
import { GAP_WEEKS, emptyWeekdays, gapWindow, weekdayName } from '../../../server/calendar-gaps';
import { copilotHref } from '../../../server/copilot-surface';
import {
  messages,
  optionalMessage,
  statusMessage,
  translator,
  type MessageKey,
} from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { CalendarView, type SchedulableDraft, type SlotDetail } from './calendar-view';
import { cancelScheduleAction, rescheduleContentAction, scheduleContentAction } from './actions';
import { submitForReviewAction } from '../content/actions';

export const dynamic = 'force-dynamic';

/**
 * The Content Calendar — Phase 5B-2's planning half, docs/PRODUCT.md §5 module 6.
 *
 * EVERY DATE ON THIS PAGE IS COMPUTED IN THE WORKSPACE'S ZONE. The month's
 * range, the day a slot lands on, the weekday a month starts on and the day
 * labels are all resolved through the zone the workspace configured — not the
 * server's, and not the browser's. A calendar that renders in the server's zone
 * puts the first and last few hours of every month on the wrong page for every
 * customer but one.
 *
 * NOTHING HERE PUBLISHES (AC-14.7). The page reads slots and renders them; the
 * only writes are the three server actions, and none of them touches a network.
 */

/** Which day of the week a date falls on, in a zone. 0 = Sunday. */
function weekdayInZone(instant: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(
    instant,
  );
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/** `YYYY-MM` → its two numbers, or the current month in the workspace's zone. */
function requestedMonth(raw: string | undefined, timezone: string, now: Date) {
  const match = /^(\d{4})-(\d{2})$/.exec(raw ?? '');
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month >= 1 && month <= 12 && year >= 1970 && year <= 9999) return { year, month };
  }
  const parts = partsInZone(now, timezone);
  return { year: parts.year, month: parts.month };
}

function monthKey(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

function shiftMonth(year: number, month: number, delta: number): string {
  const zeroBased = year * 12 + (month - 1) + delta;
  return monthKey(Math.floor(zeroBased / 12), (zeroBased % 12) + 1);
}

/** The platform keys the preview component knows. Anything else is dropped. */
const KNOWN_PLATFORMS: readonly SocialPlatform[] = [
  'instagram',
  'facebook',
  'linkedin',
  'x',
  'tiktok',
];

/**
 * THE SLOT'S OWN STATE, NOT AN ASSUMPTION ABOUT IT (AC-29.2).
 *
 * This screen used to render every slot as `SCHEDULED` with a comment saying
 * the publishing states "will be used in Phase 6". Phase 6 shipped, and the
 * comment stopped being true: a planner looking at last week saw a month of
 * posts marked scheduled, several of which had already gone out and one of
 * which had failed.
 *
 * `PLANNED` MAPS TO `DRAFT`, because that is what it means — on the calendar
 * and not yet cleared to go — and the card draws its draft watermark for it.
 * `CANCELLED` never reaches here: `listSlots` excludes it.
 */
const SLOT_STATUS: Record<string, PostStatus> = {
  PLANNED: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  PUBLISHING: 'PUBLISHING',
  PUBLISHED: 'PUBLISHED',
  PARTIALLY_PUBLISHED: 'PARTIALLY_PUBLISHED',
  FAILED: 'FAILED',
};

/**
 * THE REVIEW STATE, FROM THE APPROVAL ROW.
 *
 * NO ROW MEANS `NOT_REQUIRED`, and the distinction matters: a brand that does
 * not require approval before scheduling produces content with no approval at
 * all, and rendering that as "needs approval" would invent a queue nobody is
 * waiting in. `REJECTED` and `CANCELLED` both mean the reviewer did not let it
 * through, which for a planner reads as changes requested — the post is not
 * cleared, and the detail is on the item.
 */
const APPROVAL_STATE: Record<string, ApprovalStatus> = {
  PENDING: 'NEEDS_APPROVAL',
  APPROVED: 'APPROVED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  REJECTED: 'CHANGES_REQUESTED',
  CANCELLED: 'NOT_REQUIRED',
};

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const translate = translator(locale);
  const access = await requireWorkspacePage(locale, '/calendar');
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;

  const single = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  /*
   * PHASE 6 FINAL (D-277 §32, D-290) — THE FILTERS: brand, platform, campaign
   * and status. They NARROW what the member may already see; the month is
   * read under RLS and BrandScope first, then filtered here. A malformed value
   * is simply ignored.
   */
  const UUID_PATTERN = /^[0-9a-f-]{36}$/i;
  const filterBrand = UUID_PATTERN.test(single('brand') ?? '') ? single('brand') : undefined;
  const filterCampaign = UUID_PATTERN.test(single('campaign') ?? '')
    ? single('campaign')
    : undefined;
  const filterPlatform = /^[a-z0-9_-]{1,40}$/.test(single('platform') ?? '')
    ? single('platform')
    : undefined;
  const FILTER_STATUSES = ['PLANNED', 'SCHEDULED', 'PUBLISHED', 'FAILED'] as const;
  const filterStatus = (FILTER_STATUSES as readonly string[]).includes(single('status') ?? '')
    ? single('status')
    : undefined;

  const data = await inContentStudio(workspace.workspaceId, async (services) => {
    const calendar = await services.calendar();
    const library = await services.library();
    const policy = await services.policy();
    const timezone = calendar.timezone;
    /*
     * A9 (D-330) — THE WORKSPACE'S OWN WEEK START, set in Settings → General;
     * without one, the activated configuration's. The country is read here too
     * for the ★ chips below.
     */
    const workspaceRow = await services.db.workspace.findUnique({
      where: { id: workspace.workspaceId },
      select: { country: true, weekStartsOn: true },
    });
    const weekStartsOn = workspaceRow?.weekStartsOn ?? policy.calendar.weekStartsOn;
    const now = systemClock.now();
    const { year, month } = requestedMonth(single('month'), timezone, now);

    /*
     * THE MEMBER'S OWN BRANDS, APPLIED IN THE QUERY.
     *
     * RLS already keeps another tenant's slots out; the scope keeps a brand
     * outside this member's own scope out too. It used to be a `.filter()`
     * over the whole workspace's month — which fetched rows the reader may not
     * see so that JavaScript could drop them, and would have made any count or
     * page boundary computed from the list a boundary over invisible rows.
     * `brandIdScopeFilter` reads an empty scope as UNRESTRICTED, which is the
     * platform rule, so passing it straight through is correct for both cases.
     */
    const visible = (
      await calendar.monthView({
        year,
        month,
        brandScope: workspace.brandScope,
      })
    ).filter(
      (view) =>
        (!filterBrand || view.slot.brandId === filterBrand) &&
        (!filterCampaign || view.item.campaignId === filterCampaign) &&
        (!filterPlatform || view.slot.platformKeys.includes(filterPlatform)) &&
        (!filterStatus || view.slot.status === filterStatus),
    );

    /*
     * CONTENT THAT CAN ACTUALLY BE SCHEDULED, and the "actually" is the point.
     * An item with no variant has no caption to publish, and the service
     * refuses it — so offering it in the picker would be offering a choice that
     * fails. The list is what the service would accept, computed the same way.
     *
     * DRAFT **AND APPROVED**, which is what `SCHEDULABLE_FROM` says. The picker
     * offered drafts only, and that made the approval workflow a dead end: with
     * a brand's `requireApprovalBeforeScheduling` switched on, a DRAFT is
     * refused by the gate and an APPROVED post was never offered — so nothing
     * at all could be scheduled, and the one status the gate exists to admit
     * was the one status the screen hid. `SCHEDULED` is deliberately absent: it
     * is already on the calendar, and rescheduling has its own control.
     */
    /*
     * THE UNSCHEDULED TRAY (D-290): schedulable posts with a variant and NO
     * live slot. A draft already planned on the calendar (waiting on approval)
     * is not "unscheduled", so it is not offered twice. Both conditions are in
     * the query (`unscheduledOnly`), so the page limit is never spent on posts
     * the tray would drop.
     */
    const schedulable = (
      await library.listItems({
        statuses: ['DRAFT', 'APPROVED'],
        unscheduledOnly: true,
        limit: 200,
        brandScope: workspace.brandScope,
        ...(filterBrand ? { brandId: filterBrand } : {}),
        ...(filterCampaign ? { campaignId: filterCampaign } : {}),
        ...(filterPlatform ? { platformKey: filterPlatform } : {}),
      })
    ).filter((item) => item.variants.length > 0);
    /*
     * THE ONE QUIET SUGGESTION (D-290): a weekday nothing went on for the last
     * GAP_WEEKS whole weeks, from the brand's own slots. Read under RLS and the
     * member's BrandScope (plus the brand filter); a cancelled slot is not a
     * post. The UTC range is padded a day each side and narrowed by LOCAL date.
     */
    const gapRange = gapWindow(formatLocalTime(now, timezone).slice(0, 10), weekStartsOn);
    const gapSlots = await services.db.calendarSlot.findMany({
      where: {
        status: { not: 'CANCELLED' },
        scheduledAtUtc: {
          gte: new Date(Date.parse(`${gapRange.start}T00:00:00Z`) - 86_400_000),
          lt: new Date(Date.parse(`${gapRange.end}T00:00:00Z`) + 86_400_000),
        },
        ...(filterBrand
          ? { brandId: filterBrand }
          : workspace.brandScope.length > 0
            ? { brandId: { in: [...workspace.brandScope] } }
            : {}),
      },
      select: { scheduledAtUtc: true },
      take: 2_000,
    });
    const gapDays = emptyWeekdays(
      gapSlots.map((slot) => formatLocalTime(slot.scheduledAtUtc, timezone).slice(0, 10)),
      gapRange,
    );
    const [filterBrands, openNotes] = await Promise.all([
      services.db.brand.findMany({
        where: {
          deletedAt: null,
          ...(workspace.brandScope.length > 0 ? { id: { in: [...workspace.brandScope] } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      }),
      services.db.noteThread.groupBy({
        by: ['contentItemId'],
        where: {
          contentItemId: { in: visible.map((view) => view.item.id) },
          status: 'OPEN',
        },
        _count: { _all: true },
      }),
    ]);

    /*
     * PHASE 8 — THE REST OF WHAT A PLANNER IS LOOKING AT (AC-29.2).
     *
     * A month grid that shows only a title and a time is a list of reminders.
     * The three facts a planner actually scans for are which campaign a post
     * belongs to, whether a reviewer has cleared it, and whether it went out —
     * and all three already exist in the canonical models. NOTHING HERE
     * DUPLICATES POST STATE: the slot carries the publishing status, the
     * `Approval` row carries the review, and `ContentItem.campaignId` carries
     * the campaign. This page joins them; it stores nothing.
     */
    const approvals = await services.approvals();
    const campaignService = services.campaigns();
    const [quotaLimit, counter, approvalStates, campaigns] = await Promise.all([
      services.entitlements.limit(workspace.workspaceId, QUOTA_FEATURES.scheduledPostsPerMonth),
      services.db.usageCounter.findFirst({
        where: { featureKey: QUOTA_FEATURES.scheduledPostsPerMonth },
        orderBy: { periodStart: 'desc' },
      }),
      approvals.latestForItems({
        itemIds: visible.map((view) => view.item.id),
        brandScope: workspace.brandScope,
      }),
      /*
       * ARCHIVED CAMPAIGNS INCLUDED, deliberately. A post scheduled under a
       * campaign that has since been archived still belongs to it, and showing
       * the chip without a name would be a worse answer than the name.
       */
      campaignService.list({
        brandScope: workspace.brandScope,
        includeArchived: true,
        take: 200,
      }),
    ]);

    /*
     * G6 / Q7 (D-329) — WHAT THE COUNTRY AND THE INDUSTRY ADD: the workspace's
     * holidays, the observances of the industries of the brands in view (each
     * brand's catalogue KEY; free text maps to none), and the country's
     * suggested posting times. All three are operator configuration.
     */
    const [onboarding, brandIndustries] = await Promise.all([
      new TenantOnboardingPolicySource(services.db, currentEnvironment()).load(),
      services.db.brand.findMany({
        where: {
          deletedAt: null,
          ...(filterBrand
            ? { id: filterBrand }
            : workspace.brandScope.length > 0
              ? { id: { in: [...workspace.brandScope] } }
              : {}),
        },
        select: { industry: true },
      }),
    ]);
    const industryKeys = [
      ...new Set(
        brandIndustries
          .map((brand) => industryKeyFor(brand.industry, onboarding.industries))
          .filter((key): key is string => key !== null),
      ),
    ];

    return {
      country: workspaceRow?.country ?? null,
      industryKeys,
      calendarPolicy: policy.calendar,
      timezone,
      year,
      month,
      visible,
      schedulable,
      gapDays,
      filterBrands,
      platformKeys: policy.platforms.map((platform) => platform.key),
      openNotes: new Map(
        openNotes.map((row) => [row.contentItemId ?? '', row._count._all] as const),
      ),
      quotaLimit,
      quotaUsed: counter?.usedValue ?? 0,
      weekStartsOn,
      now,
      approvalStates,
      campaignNames: new Map(campaigns.map((campaign) => [campaign.id, campaign.name])),
    };
  });

  const {
    timezone,
    year,
    month,
    visible,
    schedulable,
    gapDays,
    quotaLimit,
    quotaUsed,
    weekStartsOn,
    now,
    approvalStates,
    campaignNames,
    filterBrands,
    platformKeys,
    openNotes,
    country,
    industryKeys,
    calendarPolicy,
  } = data;

  /*
   * PHASE 6 · P6-10 — WHETHER EACH SCHEDULED POST HAS A ROUTE TO ITS PLATFORM.
   *
   * THE SILENCE THIS ENDS. `materialiseSlot` creates a job per ACTIVE
   * connection with a matching variant; a brand with no connection for a
   * channel produces no job, the sweep counts zero, and the slot stays
   * `SCHEDULED` for ever with nothing written and nothing failed. So the month
   * showed posts that read as on their way and had no route to a platform.
   *
   * READ THROUGH `inSocial` RATHER THAN THE STUDIO'S CLIENT, because that is
   * where the publishing policy and the connection projection already live —
   * and because the service it builds carries NEITHER a vault NOR an
   * application resolver, so this page cannot open a credential (F-07).
   */
  const mayReadAccounts = workspace.permissionKeys.includes('integrations.read');
  const { readiness, latenessMinutes } = await inSocial(workspace.workspaceId, async (services) => {
    const publishingPolicy = await services.policy();
    return {
      // Q9 (D-332): how long an expired channel waits for its account, said as it is.
      latenessMinutes: publishingPolicy.dispatch.latenessToleranceMinutes,
      readiness: await publishReadiness({
        db: services.db,
        workspaceId: workspace.workspaceId,
        policy: publishingPolicy,
        brandScope: workspace.brandScope,
        slots: visible.map((view) => ({
          slotId: view.slot.id,
          brandId: view.slot.brandId,
          status: view.slot.status,
          /*
           * THE ITEM'S VARIANTS AS THEY ARE NOW — what the publisher matches
           * connections against — and NOT `slot.platformKeys`, which records
           * what was planned and is deliberately never updated.
           */
          variantPlatformKeys: view.variants.map((variant) => variant.platformKey),
        })),
        now,
      }),
    };
  });
  const blockedCount = [...readiness.values()].filter((entry) => isBlocking(entry.state)).length;

  /*
   * THE COVER PICTURE OF EACH SCHEDULED POST (AC-29.2).
   *
   * ONE ASSET PER SLOT, not all of them: a calendar chip is thirty pixels
   * square, and minting a per-viewer download grant for every image in a
   * carousel — for every post in a month — would issue capabilities nothing on
   * this screen can show. The FIRST asset of the FIRST variant is the post's
   * cover, which is the same convention the publish pipeline uses.
   *
   * Grants are issued through the same download service the Asset Library and
   * the composer use, which re-checks `assets.read`, the workspace and the
   * member's BrandScope. An id it will not resolve is simply absent, and the
   * chip falls back to its abstract tile rather than showing a broken frame.
   */
  const coverOf = new Map<string, string>();
  for (const view of visible) {
    const cover = view.variants.flatMap((variant) => variant.assetIds)[0];
    if (cover) coverOf.set(view.slot.id, cover);
  }
  const coverMedia = await mediaForVariants({
    workspaceId: workspace.workspaceId,
    userId: customer.userId,
    permissionKeys: workspace.permissionKeys,
    brandScope: workspace.brandScope,
    assetIds: [...coverOf.values()],
  });

  /*
   * THE GRID, BUILT IN THE WORKSPACE'S ZONE.
   *
   * Six weeks from the configured week start, so a month that begins on the
   * last configured weekday still shows whole. `Date.UTC` is used only as
   * calendar ARITHMETIC over a day number — the rendering of each cell goes
   * through the zone, so nothing here depends on the server's own offset.
   */
  const firstOfMonthUtc = Date.UTC(year, month - 1, 1);
  const firstWeekday = weekdayInZone(new Date(firstOfMonthUtc + 12 * 3_600_000), timezone);
  const lead = (firstWeekday - weekStartsOn + 7) % 7;

  const dayFormatter = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    timeZone: 'UTC',
    day: 'numeric',
  });
  const longFormatter = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const weekdayFormatter = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    timeZone: 'UTC',
    weekday: 'short',
  });
  const timeFormatter = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  });

  /** Slots bucketed by the local day they fall on. */
  const byDay = new Map<string, PostRecord[]>();
  const slotDetails: SlotDetail[] = [];
  for (const view of visible) {
    const local = formatLocalTime(view.slot.scheduledAtUtc, timezone);
    const day = local.slice(0, 10);
    const channels = view.slot.platformKeys;
    const mediaIds = [...new Set(view.variants.flatMap((variant) => variant.assetIds))];
    const coverId = coverOf.get(view.slot.id);
    const cover = coverId ? coverMedia.get(coverId) : undefined;
    const campaignName = view.item.campaignId
      ? (campaignNames.get(view.item.campaignId) ?? null)
      : null;
    const approvalRow = approvalStates.get(view.item.id);
    const approval: ApprovalStatus = approvalRow
      ? (APPROVAL_STATE[approvalRow] ?? 'NOT_REQUIRED')
      : 'NOT_REQUIRED';
    const status = SLOT_STATUS[view.slot.status] ?? 'SCHEDULED';
    const slotReadiness = readiness.get(view.slot.id) ?? null;

    const record: PostRecord = {
      id: view.slot.id,
      caption: view.item.title,
      captionDirection: view.item.primaryLocale === 'AR' ? 'rtl' : 'ltr',
      platforms: channels.filter((key): key is SocialPlatform =>
        (KNOWN_PLATFORMS as readonly string[]).includes(key),
      ),
      // The campaign the post belongs to, when it belongs to one. A planner
      // reads a month by campaign far more often than by anything else.
      accountName: campaignName ?? view.item.title,
      status,
      approval,
      whenLabel: timeFormatter.format(view.slot.scheduledAtUtc),
      mediaSeed: (view.slot.id.charCodeAt(0) % 6) as 0 | 1 | 2 | 3 | 4 | 5,
      // The picture's own name when there is one, so a screen-reader user hears
      // what the post is illustrated with rather than the title twice.
      mediaAlt: cover?.name ?? view.item.title,
      ...(cover?.previewToken ? { mediaSrc: `/${locale}/assets/file/${cover.previewToken}` } : {}),
      ...(mediaIds.length > 1 ? { mediaCount: mediaIds.length } : {}),
      ...(cover?.kind === 'VIDEO' ? { isVideo: true } : {}),
    };
    byDay.set(day, [...(byDay.get(day) ?? []), record]);
    slotDetails.push({
      slotId: view.slot.id,
      contentItemId: view.item.id,
      title: view.item.title,
      date: day,
      time: local.slice(11, 16),
      channels,
      campaignName,
      statusLabel: translate(`content.status.${status}` as MessageKey),
      // Null when there is no approval row at all — "not required" is the
      // absence of a review, not a state to display beside one.
      approvalLabel: approvalRow
        ? translate(`approvals.status.${approvalRow}` as MessageKey)
        : null,
      mediaCount: mediaIds.length,
      // D-290 — what the drawer previews: the first version's words and cover.
      itemStatus: view.item.status,
      reschedulable: RESCHEDULABLE_SLOT_STATUSES.includes(view.slot.status),
      previewPlatform: view.variants[0]?.platformKey ?? null,
      previewBody: view.variants[0]?.body ?? '',
      previewMedia: cover
        ? [{ id: cover.id, name: cover.name, kind: cover.kind, previewToken: cover.previewToken }]
        : [],
      openNotes: openNotes.get(view.item.id) ?? 0,
      /*
       * ABSENT RATHER THAN REASSURING for a slot that is not waiting to go
       * out. `publishReadiness` assesses `SCHEDULED` alone, so a planned or an
       * already-published slot has no entry and the dialog renders no row —
       * the honest rendering of "this question does not apply" (D-184).
       */
      readiness: slotReadiness
        ? {
            label: translate(`calendar.readiness.${slotReadiness.state}` as MessageKey),
            blocking: isBlocking(slotReadiness.state),
            /*
             * ONLY THE CHANNELS THAT NEED ATTENTION — the blocked ones, and
             * (Q9, D-332) an EXPIRED one, which does not block but waits for
             * its account, with what that means on the next line. Listing the
             * healthy ones beside them would bury the line the planner has to
             * act on.
             *
             * THE ACCOUNT'S NAME IS WITHHELD FROM A READER WHO MAY NOT SEE IT.
             * This screen needs `content.read`; the connected accounts are an
             * `integrations.read` surface. The STATE is about the reader's own
             * post and is theirs to know; the account's display name is not,
             * so it is dropped rather than the row being hidden.
             */
            channels: slotReadiness.channels
              .filter((channel) => needsAttention(channel.state))
              .map((channel) => ({
                platformKey: channel.platformKey,
                label: translate(`calendar.readiness.${channel.state}` as MessageKey),
                explanation:
                  channel.state === 'EXPIRED'
                    ? translate('readiness.expiredExplanation').replace(
                        '{minutes}',
                        String(latenessMinutes),
                      )
                    : null,
                accountName: mayReadAccounts ? channel.accountName : null,
              })),
          }
        : null,
    });
  }

  const todayKey = formatLocalTime(now, timezone).slice(0, 10);
  const mayCreate = workspace.permissionKeys.includes('content.create');
  const days: CalendarDay[] = [];
  for (let index = 0; index < 42; index += 1) {
    const cellUtc = firstOfMonthUtc + (index - lead) * 24 * 3_600_000;
    const cell = new Date(cellUtc);
    const key = cell.toISOString().slice(0, 10);
    days.push({
      key,
      label: dayFormatter.format(cell),
      longLabel: longFormatter.format(cell),
      inCurrentPeriod: cell.getUTCMonth() + 1 === month && cell.getUTCFullYear() === year,
      isToday: key === todayKey,
      // F2 — a day before today, in the workspace's zone; nothing is planned on it.
      isPast: key < todayKey,
      posts: byDay.get(key) ?? [],
    });
  }

  /*
   * G6 (D-329) — THE ★ CHIPS: a day's holidays (the workspace's country) and
   * observances (the industries of the brands in view). A chip on a day that
   * has not passed opens the Studio for that day, for a member who may create.
   */
  const firstKey = days[0]?.key ?? todayKey;
  const lastKey = days.at(-1)?.key ?? todayKey;
  const markers = [
    ...calendarMarkers(calendarPolicy, {
      country,
      industryKey: null,
      from: firstKey,
      to: lastKey,
    }),
    ...industryKeys.flatMap((industryKey) =>
      calendarMarkers(calendarPolicy, { country: null, industryKey, from: firstKey, to: lastKey }),
    ),
  ];
  for (const [index, day] of days.entries()) {
    const onDay = markers.filter((marker) => marker.date === day.key);
    if (onDay.length === 0) continue;
    days[index] = {
      ...day,
      markers: onDay.map((marker) => ({
        label: locale === 'ar' ? marker.name.ar : marker.name.en,
        kind: marker.kind,
        href:
          mayCreate && day.key >= todayKey
            ? `/${locale}/content/compose?date=${day.key}`
            : undefined,
      })),
    };
  }

  /*
   * G6 (D-329) — "SUGGESTED TIME", never "best time": the country's configured
   * posting times, used only where no measured best time exists for the brand.
   * No measured source exists yet, so `measured` is empty and says so.
   */
  const suggested = suggestedPostingTimes(calendarPolicy, { measured: [], country });
  const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(single('date') ?? '')
    ? single('date')
    : undefined;

  const todayIndex = days.findIndex((day) => day.isToday);
  const weekIndex = todayIndex >= 0 ? Math.floor(todayIndex / 7) : 0;

  const weekdayNames = Array.from({ length: 7 }, (_unused, offset) =>
    // 2024-01-07 was a Sunday, so adding the configured start gives the right
    // first column whichever day the market begins its week on.
    weekdayFormatter.format(new Date(Date.UTC(2024, 0, 7 + ((weekStartsOn + offset) % 7)))),
  );

  const periodLabel = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
  }).format(new Date(firstOfMonthUtc));

  const t = dictionaryFor(translate, locale);
  const ok = single('ok') ?? null;
  const error = single('error') ?? null;
  const reference = single('ref');
  const successText = ok ? statusMessage(ok, locale) : null;
  const errorText = error ? statusMessage(error, locale, reference) : null;

  const brandContext = await brandContextFor(workspace, '/calendar');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={translate('calendar.title')}
      description={translate('calendar.subtitle')}
      activePath="/calendar"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {successText ? <CustomerBanner tone="success">{successText}</CustomerBanner> : null}
      {errorText ? <CustomerBanner tone="error">{errorText}</CustomerBanner> : null}
      {/*
        THE MONTH'S BLOCKED POSTS, COUNTED — and `warning` rather than `error`,
        because the screen is working exactly as intended and the reader still
        has to be told. Rendered only when the count is non-zero: a banner
        reading "0 posts will not go out" is noise on every healthy month.

        THE LINK IS OFFERED ONLY TO SOMEBODY WHO CAN ACT ON IT. Connecting and
        reconnecting an account needs `integrations.manage`; sending a member
        without it to a route they will be refused is the dead control §20
        forbids. The count is still shown, because knowing the post will not go
        out is what lets them ask somebody who can fix it.
      */}
      {blockedCount > 0 ? (
        <CustomerBanner tone="warning">
          <span data-testid="calendar-readiness-banner">
            {`${blockedCount} ${translate('calendar.readinessBlocked')}`}
          </span>
          {workspace.permissionKeys.includes('integrations.manage') ? (
            <>
              {' '}
              <a href={`/${locale}/publishing?tab=accounts`} data-testid="calendar-readiness-fix">
                {translate('calendar.readinessFix')}
              </a>
            </>
          ) : null}
        </CustomerBanner>
      ) : null}
      <CalendarView
        locale={locale}
        today={todayKey}
        tomorrow={nextDayKey(todayKey)}
        defaultTime={suggested.times[0] ?? DEFAULT_POST_TIME}
        suggestedTimes={suggested.times}
        preselectDate={requestedDate && requestedDate >= todayKey ? requestedDate : undefined}
        preselectItemId={single('item')}
        weekIndex={weekIndex}
        gaps={gapDays.map((day) =>
          translate('calendar.gap.empty')
            .replace('{weekday}', weekdayName(day, locale === 'ar' ? 'ar' : 'en'))
            .replace('{weeks}', String(GAP_WEEKS)),
        )}
        copilotHref={
          workspace.permissionKeys.includes('copilot.use') ? copilotHref(locale, 'calendar') : null
        }
        filters={{
          brand: filterBrand ?? '',
          campaign: filterCampaign ?? '',
          platform: filterPlatform ?? '',
          status: filterStatus ?? '',
        }}
        filterOptions={{
          brands: filterBrands,
          campaigns: [...campaignNames].map(([id, name]) => ({ id, name })),
          platforms: platformKeys.map((key) => ({
            key,
            label: optionalMessage(locale, `content.platform.${key}`) ?? key,
          })),
          statuses: FILTER_STATUSES.map((status) => ({
            key: status,
            label: translate(
              `content.status.${status === 'PLANNED' ? 'DRAFT' : status}` as MessageKey,
            ),
          })),
        }}
        t={t}
        periodLabel={periodLabel}
        month={monthKey(year, month)}
        previousMonth={shiftMonth(year, month, -1)}
        nextMonth={shiftMonth(year, month, 1)}
        currentMonth={todayKey.slice(0, 7)}
        days={days}
        slots={slotDetails}
        drafts={schedulable.map((item): SchedulableDraft => ({
          id: item.id,
          title: item.title,
          channels: [...new Set(item.variants.map((variant) => variant.platformKey))],
          status: item.status,
          campaignName: item.campaignId ? (campaignNames.get(item.campaignId) ?? null) : null,
        }))}
        timezone={timezone}
        quotaUsed={quotaUsed}
        quotaLimit={quotaLimit}
        canSchedule={workspace.permissionKeys.includes('content.schedule')}
        canSubmit={workspace.permissionKeys.includes('content.submit')}
        postsOnDayLabel={translate('calendar.postsOnDay')}
        labels={{
          calendarLabel: translate('calendar.label'),
          monthView: translate('calendar.month'),
          weekView: translate('calendar.week'),
          agendaView: translate('calendar.agenda'),
          today: translate('calendar.today'),
          previous: translate('calendar.previous'),
          next: translate('calendar.next'),
          createPost: translate('calendar.scheduleSubmit'),
          weekdayNames,
          emptyDay: translate('calendar.emptyDay'),
          emptyPeriodTitle: translate('calendar.emptyTitle'),
          emptyPeriodBody: translate('calendar.emptyBody'),
          openLabel: translate('calendar.openPost'),
          selectLabel: translate('calendar.select'),
          /*
           * PHASE 8 — REAL NAMES FOR REAL STATES.
           *
           * Every one of these but `DRAFT` used to read "Goes out", and every
           * approval label read "Mock target — nothing publishes yet". That
           * was honest while a slot could only ever be scheduled and nothing
           * published; it stopped being honest the moment this page started
           * rendering the slot's own status, because a chip's ACCESSIBLE NAME
           * states its status in words (WCAG 1.4.1) — so a published post
           * announced itself as "goes out" to a screen-reader user.
           */
          statusLabels: {
            DRAFT: translate('content.status.DRAFT'),
            SCHEDULED: translate('content.status.SCHEDULED'),
            PUBLISHING: translate('content.status.PUBLISHING'),
            PUBLISHED: translate('content.status.PUBLISHED'),
            PARTIALLY_PUBLISHED: translate('content.status.PARTIALLY_PUBLISHED'),
            FAILED: translate('content.status.FAILED'),
          },
          approvalLabels: {
            // `NOT_REQUIRED` is never rendered — the card omits the badge — but
            // the record must be total, and an empty string would be a badge
            // with no name if that ever changed.
            NOT_REQUIRED: translate('approvals.notRequired'),
            NEEDS_APPROVAL: translate('approvals.status.PENDING'),
            APPROVED: translate('approvals.status.APPROVED'),
            CHANGES_REQUESTED: translate('approvals.status.CHANGES_REQUESTED'),
          },
          platformNames: {
            instagram: translate('content.platform.instagram'),
            facebook: translate('content.platform.facebook'),
            linkedin: translate('content.platform.linkedin'),
            x: translate('content.platform.x'),
            tiktok: translate('content.platform.tiktok'),
          },
        }}
        actions={{
          schedule: scheduleContentAction,
          reschedule: rescheduleContentAction,
          cancel: cancelScheduleAction,
          submitForReview: submitForReviewAction,
        }}
      />
    </WorkspaceShell>
  );
}

const CALENDAR_KEYS = [
  'calendar.emptySchedule',
  'calendar.emptyCreate',
  'calendar.title',
  'calendar.eyebrow',
  'calendar.subtitle',
  'calendar.label',
  'calendar.timezoneNote',
  'calendar.quota',
  'calendar.quotaUnlimited',
  'calendar.scheduleTitle',
  'calendar.scheduleDraft',
  'calendar.scheduleDate',
  'calendar.pastDay',
  'calendar.moveFromPost',
  'calendar.scheduleTime',
  'calendar.suggestedTime',
  'calendar.scheduleSubmit',
  'calendar.rescheduleTitle',
  'calendar.rescheduleSubmit',
  'calendar.cancelSubmit',
  'calendar.noSchedulable',
  'calendar.noSchedulableBody',
  'calendar.openInStudio',
  'calendar.slotDialogHint',
  'calendar.readiness',
  'calendar.readiness.READY',
  'calendar.readiness.EXPIRING',
  'calendar.readiness.EXPIRED',
  'calendar.readiness.REVOKED',
  'calendar.readiness.NOT_CONNECTED',
  'calendar.readiness.UNSUPPORTED',
  'calendar.channels',
  'calendar.campaign',
  'calendar.publishState',
  'calendar.approvalState',
  'calendar.drawer.notes',
  'calendar.drawer.requestApproval',
  'calendar.filter.all',
  'calendar.filter.apply',
  'calendar.filter.brand',
  'calendar.filter.campaign',
  'calendar.filter.platform',
  'calendar.filter.status',
  'calendar.gap.ask',
  'calendar.gap.title',
  'calendar.tray.empty',
  'calendar.tray.hint',
  'calendar.tray.showAll',
  'calendar.tray.showFewer',
  'calendar.tray.title',
  'calendar.media',
  'calendar.scheduledFor',
  'common.close',
] as const satisfies readonly MessageKey[];

function dictionaryFor(
  translate: (key: MessageKey) => string,
  locale: string,
): Record<string, string> {
  /*
   * The calendar's own words, plus what the post drawer's preview reads
   * (D-290) — status, platform, format and preview labels, nothing more.
   */
  const all = messages[locale === 'ar' ? 'ar' : 'en'] as Record<string, string>;
  const preview = Object.fromEntries(
    Object.entries(all).filter(
      ([key]) =>
        key.startsWith('content.status.') ||
        key.startsWith('content.platform.') ||
        key.startsWith('content.format.') ||
        key.startsWith('content.preview.') ||
        key.startsWith('editor.preview.') ||
        key === 'content.media.video',
    ),
  );
  return { ...preview, ...Object.fromEntries(CALENDAR_KEYS.map((key) => [key, translate(key)])) };
}
