import { formatLocalTime, partsInZone } from '@brandspace/content';
import { QUOTA_FEATURES } from '@brandspace/entitlements';
import { systemClock } from '@brandspace/shared';
import type { CalendarDay, PostRecord, SocialPlatform } from '@brandspace/ui';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor } from '../../../server/brand-context';
import { inContentStudio } from '../../../server/content-context';
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

    const [quotaLimit, counter] = await Promise.all([
      services.entitlements.limit(workspace.workspaceId, QUOTA_FEATURES.scheduledPostsPerMonth),
      services.db.usageCounter.findFirst({
        where: { featureKey: QUOTA_FEATURES.scheduledPostsPerMonth },
        orderBy: { periodStart: 'desc' },
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
    };
  });

  const { timezone, year, month, visible, schedulable, quotaLimit, quotaUsed, weekStartsOn, now } =
    data;

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
    const record: PostRecord = {
      id: view.slot.id,
      caption: view.item.title,
      captionDirection: view.item.primaryLocale === 'AR' ? 'rtl' : 'ltr',
      platforms: channels.filter((key): key is SocialPlatform =>
        (KNOWN_PLATFORMS as readonly string[]).includes(key),
      ),
      accountName: view.item.title,
      // Every slot this phase can create is SCHEDULED. `PostStatus` carries
      // publishing states the pipeline will use in Phase 6; none is reachable
      // here, so none is rendered.
      status: 'SCHEDULED',
      approval: 'NOT_REQUIRED',
      whenLabel: timeFormatter.format(view.slot.scheduledAtUtc),
      mediaSeed: (view.slot.id.charCodeAt(0) % 6) as 0 | 1 | 2 | 3 | 4 | 5,
      mediaAlt: view.item.title,
    };
    byDay.set(day, [...(byDay.get(day) ?? []), record]);
    slotDetails.push({
      slotId: view.slot.id,
      contentItemId: view.item.id,
      title: view.item.title,
      date: day,
      time: local.slice(11, 16),
      channels,
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
          statusLabels: {
            DRAFT: translate('content.status.DRAFT'),
            SCHEDULED: translate('calendar.scheduledFor'),
            PUBLISHING: translate('calendar.scheduledFor'),
            PUBLISHED: translate('calendar.scheduledFor'),
            FAILED: translate('calendar.scheduledFor'),
          },
          approvalLabels: {
            NOT_REQUIRED: translate('calendar.mockTarget'),
            NEEDS_APPROVAL: translate('calendar.mockTarget'),
            APPROVED: translate('calendar.mockTarget'),
            CHANGES_REQUESTED: translate('calendar.mockTarget'),
          },
          platformNames: {
            instagram: translate('content.platform.instagram'),
            facebook: translate('content.platform.instagram'),
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
  'calendar.scheduledFor',
  'common.close',
] as const satisfies readonly MessageKey[];

function dictionaryFor(translate: (key: MessageKey) => string): Record<string, string> {
  return Object.fromEntries(CALENDAR_KEYS.map((key) => [key, translate(key)]));
}
