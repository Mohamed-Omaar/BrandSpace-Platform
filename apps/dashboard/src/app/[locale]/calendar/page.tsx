import { formatLocalTime, partsInZone } from '@brandspace/content';
import { QUOTA_FEATURES } from '@brandspace/entitlements';
import { systemClock } from '@brandspace/shared';
import type { ApprovalStatus, CalendarDay, PostRecord, PostStatus, SocialPlatform } from '@brandspace/ui';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor } from '../../../server/brand-context';
import { inContentStudio } from '../../../server/content-context';
import { mediaForVariants } from '../../../server/media-picker';
import { statusMessage, translator, type MessageKey } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { CalendarView, type SchedulableDraft, type SlotDetail } from './calendar-view';
import { cancelScheduleAction, rescheduleContentAction, scheduleContentAction } from './actions';

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
  const { customer, workspace } = await requireWorkspace(locale, 'content.read');

  const single = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const data = await inContentStudio(workspace.workspaceId, async (services) => {
    const calendar = await services.calendar();
    const library = await services.library();
    const policy = await services.policy();
    const timezone = calendar.timezone;
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
    const visible = await calendar.monthView({
      year,
      month,
      brandScope: workspace.brandScope,
    });

    /*
     * DRAFTS THAT CAN ACTUALLY BE SCHEDULED, and the "actually" is the point.
     * An item with no variant has no caption to publish, and the service
     * refuses it — so offering it in the picker would be offering a choice that
     * fails. The list is what the service would accept, computed the same way.
     */
    const schedulable = (
      await library.listItems({ status: 'DRAFT', limit: 200, brandScope: workspace.brandScope })
    ).filter((item) => item.variants.length > 0);

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

    return {
      timezone,
      year,
      month,
      visible,
      schedulable,
      quotaLimit,
      quotaUsed: counter?.usedValue ?? 0,
      weekStartsOn: policy.calendar.weekStartsOn,
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
    quotaLimit,
    quotaUsed,
    weekStartsOn,
    now,
    approvalStates,
    campaignNames,
  } = data;

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
      ...(cover?.previewToken
        ? { mediaSrc: `/${locale}/assets/file/${cover.previewToken}` }
        : {}),
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
      approvalLabel: approvalRow ? translate(`approvals.status.${approvalRow}` as MessageKey) : null,
      mediaCount: mediaIds.length,
    });
  }

  const todayKey = formatLocalTime(now, timezone).slice(0, 10);
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
      posts: byDay.get(key) ?? [],
    });
  }

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

  const t = dictionaryFor(translate);
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
      <CalendarView
        locale={locale}
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
        }))}
        timezone={timezone}
        quotaUsed={quotaUsed}
        quotaLimit={quotaLimit}
        canSchedule={workspace.permissionKeys.includes('content.schedule')}
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
        }}
      />
    </WorkspaceShell>
  );
}

const CALENDAR_KEYS = [
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
  'calendar.scheduleTime',
  'calendar.scheduleSubmit',
  'calendar.rescheduleTitle',
  'calendar.rescheduleSubmit',
  'calendar.cancelSubmit',
  'calendar.noSchedulable',
  'calendar.noSchedulableBody',
  'calendar.openInStudio',
  'calendar.mockTarget',
  'calendar.channels',
  'calendar.campaign',
  'calendar.publishState',
  'calendar.approvalState',
  'calendar.media',
  'calendar.scheduledFor',
  'common.close',
] as const satisfies readonly MessageKey[];

function dictionaryFor(translate: (key: MessageKey) => string): Record<string, string> {
  return Object.fromEntries(CALENDAR_KEYS.map((key) => [key, translate(key)]));
}
