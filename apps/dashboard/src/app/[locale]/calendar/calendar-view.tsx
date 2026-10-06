'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { flushSync } from 'react-dom';
import {
  AbstractMedia,
  Banner,
  CalendarAgenda,
  CalendarDropStrip,
  Dialog,
  Field,
  SideSheet,
  StateMessage,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
  showToast,
  stripDayKeys,
  useCalendarDrag,
  type CalendarDay,
  type CalendarLabels,
  type DropState,
  type MediaSeed,
  type PostRecord,
  buttonClass,
} from '@brandspace/ui';
import type { MoveSlotResult } from './actions';
import { pendingMoves, withMoves } from './optimistic-moves';
import { VariantPreview, previewLabels } from '../content/compose/variant-preview';
import { CopilotLink } from '../../../components/copilot-link';
import { FiltersDisclosure } from '../../../components/filters-disclosure';
import { MoreDisclosure } from '../../../components/more-disclosure';
import {
  PrototypeCalendar,
  type CalendarPostKind,
  type CalendarViewMode,
  type ProtoCalendarDay,
  type ProtoCalendarPost,
} from './prototype-calendar';

/**
 * The Content Calendar — the customer screen.
 *
 * PORTED FROM `prototype-2026-09-27` (D-468, batch 2): the head row, the month,
 * week and agenda views, the post and day popovers, the move banner and the
 * legend are `PrototypeCalendar`, a transcription of `Main.dc.html` lines
 * 599–660. Below 768px the product's phone agenda stays (D-468 (b)).
 *
 * WHAT THIS OWNS, unchanged by the port: live period navigation in the URL,
 * the filters, the Unscheduled tray, the scheduling dialog, the pointer drag
 * and its Undo, and the post drawer (D-290) — every write goes through the
 * same four actions, so F2, the quota, the approval gate, B-4, BrandScope and
 * the audit are exactly what they were.
 *
 * THE MONTH LIVES IN THE URL. A calendar somebody links to a colleague, comes
 * back to, or reloads after moving a post has to come back to the same month.
 *
 * NOTHING ON THIS SCREEN PUBLISHES. The actions here reach no network — they
 * move a plan — but the plan they move is one the worker will act on, so P6-10
 * puts the publishing readiness of each scheduled slot in the drawer.
 */

export interface SchedulableDraft {
  readonly id: string;
  readonly title: string;
  readonly channels: readonly string[];
  /** D-290 — for the tray: DRAFT or APPROVED, and the campaign if any. */
  readonly status?: string;
  readonly campaignName?: string | null;
}

export interface SlotDetail {
  readonly slotId: string;
  readonly contentItemId: string;
  readonly title: string;
  readonly date: string;
  readonly time: string;
  readonly channels: readonly string[];
  /** Phase 8 — the campaign the post belongs to, when it belongs to one. */
  readonly campaignName: string | null;
  /** The slot's own publishing state, already translated. */
  readonly statusLabel: string;
  /** The latest review's state, or `null` when nobody has been asked. */
  readonly approvalLabel: string | null;
  /** How many pictures the post carries across its variants. */
  readonly mediaCount: number;
  /**
   * PHASE 6 · P6-10 — whether this post has a route to its platforms, or
   * `null` when the question does not apply (it is not waiting to go out).
   *
   * ALREADY TRANSLATED, like every other label on this island. The server owns
   * the words; this component owns where they sit.
   */
  readonly readiness: SlotReadinessDetail | null;
  /** D-290 — the drawer's preview and facts. */
  readonly itemStatus?: string;
  /** B-4 — whether this plan can still move (PLANNED or SCHEDULED only). */
  readonly reschedulable?: boolean;
  readonly previewPlatform?: string | null;
  readonly previewBody?: string;
  readonly previewMedia?: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly previewToken: string | null;
  }[];
  readonly openNotes?: number;
}

export interface SlotReadinessDetail {
  /** The worst of the channels, in words. */
  readonly label: string;
  /** True when the post cannot go out at all as it stands. */
  readonly blocking: boolean;
  /** Only the channels that need attention; empty when none does. */
  readonly channels: readonly {
    readonly platformKey: string;
    readonly label: string;
    /** Q9 (D-332): what an EXPIRED channel's wait means, for its own line. */
    readonly explanation?: string | null;
    /** `null` for a reader who may not see connected accounts. */
    readonly accountName: string | null;
  }[];
}

export interface CalendarViewProps {
  readonly locale: string;
  /**
   * F2 — today and tomorrow in the workspace's zone (`YYYY-MM-DD`), and the
   * time a new post is proposed for. Nothing before today can be chosen.
   */
  readonly today?: string;
  readonly tomorrow?: string;
  readonly defaultTime?: string;
  readonly t: Record<string, string>;
  readonly periodLabel: string;
  /** `YYYY-MM`, the month the URL asked for. */
  readonly month: string;
  readonly previousMonth: string;
  readonly nextMonth: string;
  readonly currentMonth: string;
  readonly days: readonly CalendarDay[];
  readonly slots: readonly SlotDetail[];
  readonly drafts: readonly SchedulableDraft[];
  /**
   * `?item=` — "Schedule" from the Content Library (D-282): the scheduling
   * dialog opens with that post chosen. Ignored unless it is a schedulable draft.
   */
  readonly preselectItemId?: string | undefined;
  /** G6 (D-329): the day a ★ chip in the Studio came from — the dialog opens on it. */
  readonly preselectDate?: string | undefined;
  /** G6 (D-329): the country's configured posting times, shown as "Suggested time". */
  readonly suggestedTimes?: readonly string[] | undefined;
  /** D-290 — the week the Week view shows, and the active filters. */
  readonly weekIndex?: number;
  /** D-290 — the quiet, measured suggestion(s): "Tuesday has been empty for 5 weeks." */
  readonly gaps?: readonly string[];
  /** Where "Give to Copilot" goes, or null when the member may not use it. */
  readonly copilotHref?: string | null;
  readonly filters?: {
    readonly brand: string;
    readonly campaign: string;
    readonly platform: string;
    readonly status: string;
  };
  readonly filterOptions?: {
    readonly brands: readonly { id: string; name: string }[];
    readonly campaigns: readonly { id: string; name: string }[];
    readonly platforms: readonly { key: string; label: string }[];
    readonly statuses: readonly { key: string; label: string }[];
  };
  readonly timezone: string;
  readonly quotaUsed: number;
  readonly quotaLimit: number | null;
  readonly canSchedule: boolean;
  /** D-468 — may start a post (`content.create`): "+ New post on this day", Duplicate. */
  readonly canCreate?: boolean;
  /** The seven weekday heads, from the configured week start (the prototype's `weekdays`). */
  readonly weekdays?: readonly string[];
  /** D-290 — may send a draft for review from the post drawer (`content.submit`). */
  readonly canSubmit?: boolean;
  /**
   * The calendar's labels, MINUS the one that is a function.
   *
   * `CalendarLabels.postsOnDay` takes a count and returns a sentence, and a
   * function cannot cross the server/client boundary — React refuses it, which
   * is the correct refusal: a closure has no serialisable form. So the server
   * sends the WORD and this island composes the function, which is the only
   * half that has to run in the browser anyway.
   */
  readonly labels: Omit<CalendarLabels, 'postsOnDay'>;
  /** The noun `postsOnDay` puts after the count, already translated. */
  readonly postsOnDayLabel: string;
  readonly actions: {
    schedule(formData: FormData): Promise<void>;
    reschedule(formData: FormData): Promise<void>;
    /**
     * §8.2 — a dragged move, or its Undo: the same reschedule, answering with
     * the outcome instead of redirecting (`moveSlotAction`).
     */
    move?(input: {
      readonly locale: string;
      readonly slotId: string;
      readonly date: string;
      readonly time: string;
      readonly expectedLocalTime?: string | undefined;
    }): Promise<MoveSlotResult>;
    cancel(formData: FormData): Promise<void>;
    submitForReview?(formData: FormData): Promise<void>;
    /** The popover's Duplicate: the content library's own action. */
    duplicate?(formData: FormData): Promise<void>;
  };
}

export function CalendarView({
  locale,
  today = '',
  tomorrow = '',
  defaultTime = '',
  t,
  periodLabel,
  month,
  previousMonth,
  nextMonth,
  currentMonth,
  days,
  slots,
  drafts,
  preselectItemId,
  preselectDate,
  suggestedTimes = [],
  weekIndex = 0,
  gaps = [],
  copilotHref = null,
  filters = { brand: '', campaign: '', platform: '', status: '' },
  filterOptions,
  timezone,
  quotaUsed,
  quotaLimit,
  canSchedule,
  canCreate = false,
  weekdays = [],
  canSubmit = false,
  labels,
  postsOnDayLabel,
  actions,
}: CalendarViewProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const preselected = drafts.some((draft) => draft.id === preselectItemId)
    ? preselectItemId
    : undefined;
  const [scheduling, setScheduling] = useState(preselected !== undefined);
  const [trayExpanded, setTrayExpanded] = useState(false);
  const [scheduleItem, setScheduleItem] = useState<string>(preselected ?? drafts[0]?.id ?? '');
  const [scheduleDate, setScheduleDate] = useState(preselectDate ?? tomorrow);
  /*
   * F2 — THE PROPOSED TIME FOLLOWS THE DAY. On a later day it is the default
   * (09:00); on TODAY it is left empty, because 09:00 may already have passed
   * in the workspace's zone and the server would refuse it. The field is
   * required, so the person picks a time that is still to come; the day they
   * chose is never moved for them.
   */
  const proposedTime = (date: string) => (date !== '' && date === today ? '' : defaultTime);
  const [scheduleTime, setScheduleTime] = useState(() => proposedTime(preselectDate ?? tomorrow));
  const chooseScheduleDate = (date: string) => {
    setScheduleDate(date);
    setScheduleTime((current) =>
      current === '' || current === defaultTime ? proposedTime(date) : current,
    );
  };
  // F2 — said when a post is dropped on a day that has passed.
  const [pastDayNotice, setPastDayNotice] = useState(false);
  const [openSlotId, setOpenSlotId] = useState<string | null>(null);

  /*
   * D-290 — ONE WAY IN, TWO GESTURES. Dropping a tray item on a day and
   * pressing its Schedule button both open the SAME dialog (the real schedule
   * action), the drop with the day already filled in. Nothing is scheduled by
   * the gesture alone; the time is always chosen and confirmed.
   */
  const openScheduleFor = (itemId: string, date = '') => {
    if (!drafts.some((draft) => draft.id === itemId)) return;
    // F2 — a day that has passed is not offered; say so rather than open a
    // dialog the server would refuse.
    if (date !== '' && today !== '' && date < today) {
      setPastDayNotice(true);
      return;
    }
    setPastDayNotice(false);
    setScheduleItem(itemId);
    const chosen = date === '' ? tomorrow : date;
    setScheduleDate(chosen);
    setScheduleTime(proposedTime(chosen));
    setScheduling(true);
  };

  /*
   * §8.2 (Phase 2B-2b) — THE POINTER DRAG. `useCalendarDrag` lifts, previews
   * and cancels; nothing here runs until a drop is COMMITTED on a day that can
   * take it. A post dragged to another day keeps its time and goes through
   * `actions.move` — the same reschedule, so F2, quota, approval, B-4, scope
   * and the audit event all apply. Drag is never the only way (WCAG 2.5.7):
   * the drawer has the date and time form.
   */
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [moves, setMoves] = useState<ReadonlyMap<string, string>>(new Map());
  const moveTo = (slotId: string, day: string | null) =>
    flushSync(() =>
      setMoves((current) => {
        const next = new Map(current);
        if (day === null) next.delete(slotId);
        else next.set(slotId, day);
        return next;
      }),
    );
  // Once the server's slots say the same, an override has nothing left to do.
  useEffect(() => {
    setMoves((current) =>
      pendingMoves(current, (id) => slots.find((slot) => slot.slotId === id)?.date),
    );
  }, [slots]);
  const shownDays = useMemo(
    () =>
      withMoves(days, moves, (postId) => slots.find((slot) => slot.slotId === postId)?.time ?? ''),
    [days, moves, slots],
  );

  // A YYYY-MM-DD in the reader's language, Western digits (§4): the short
  // weekday, the day number and the whole date. Composed from parts, so it
  // reads "Wed 21" — a single format would say "21 Wed" in English.
  const dayParts = (dayKey: string) => {
    const [year, monthNumber, dayNumber] = dayKey.split('-').map(Number);
    const date = new Date(Date.UTC(year ?? 0, (monthNumber ?? 1) - 1, dayNumber ?? 1));
    const format = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en', {
        ...options,
        timeZone: 'UTC',
      }).format(date);
    return {
      weekday: format({ weekday: 'short' }),
      label: format({ day: 'numeric' }),
      longLabel: format({ weekday: 'long', day: 'numeric', month: 'long' }),
    };
  };
  const dayName = (dayKey: string) => {
    const parts = dayParts(dayKey);
    return `${parts.weekday} ${parts.label}`;
  };
  const whenOf = (dayKey: string, time: string) =>
    time ? `${dayName(dayKey)} · ${time}` : dayName(dayKey);

  /*
   * "If the move changed the post's status, its card pulses once" — checked
   * when the server's days arrive, against the status the post had before.
   */
  const pulseAfter = useRef<{ slotId: string; status: string } | null>(null);
  useEffect(() => {
    const pending = pulseAfter.current;
    if (!pending) return;
    const post = days
      .flatMap((day) => day.posts)
      .find((candidate) => candidate.id === pending.slotId);
    if (!post || post.status === pending.status) return;
    pulseAfter.current = null;
    for (const chip of pageRef.current?.querySelectorAll<HTMLElement>(
      `[data-drag-payload="slot:${CSS.escape(pending.slotId)}"]`,
    ) ?? []) {
      chip.classList.remove('bs-status-pulse');
      void chip.offsetWidth;
      chip.classList.add('bs-status-pulse');
    }
  }, [days]);

  const refuse = (message: string) =>
    showToast({ tone: 'error', message, testId: 'calendar-move-refused' });

  /** Undo: back where it was, through the same path, under the rules as they stand now. */
  const undoMove = async (
    slotId: string,
    from: { date: string; time: string },
    movedTo: { date: string; localTime: string },
  ) => {
    if (!actions.move) return;
    moveTo(slotId, from.date);
    const result = await actions.move({
      locale,
      slotId,
      date: from.date,
      time: from.time,
      // Only while it is still where the move put it: a second Undo, or one
      // racing another move, changes nothing.
      expectedLocalTime: movedTo.localTime,
    });
    if (!result.ok) {
      // It stays moved, and the reason is said.
      moveTo(slotId, movedTo.date);
      refuse(result.message);
      return;
    }
    showToast({
      tone: 'success',
      message: (t['calendar.drag.undone'] ?? '{when}').replace(
        '{when}',
        whenOf(from.date, from.time),
      ),
    });
  };

  const commitMove = async (slot: SlotDetail, day: string, status: string) => {
    if (!actions.move) return;
    const from = { date: slot.date, time: slot.time };
    const result = await actions.move({ locale, slotId: slot.slotId, date: day, time: slot.time });
    if (!result.ok) {
      moveTo(slot.slotId, null);
      refuse(result.message);
      return;
    }
    pulseAfter.current = { slotId: slot.slotId, status };
    showToast({
      tone: 'success',
      message: (t['calendar.drag.moved'] ?? '{when}').replace('{when}', whenOf(day, slot.time)),
      action: {
        label: t['calendar.drag.undo'] ?? '',
        testId: 'calendar-undo',
        onAction: () => {
          void undoMove(slot.slotId, from, { date: day, localTime: result.localTime });
        },
      },
    });
  };

  const onDrop = (payload: string, day: string): 'moved' | 'opened' | 'ignored' => {
    if (payload.startsWith('item:')) {
      openScheduleFor(payload.slice('item:'.length), day);
      return 'opened';
    }
    const slotId = payload.startsWith('slot:') ? payload.slice('slot:'.length) : '';
    const slot = slots.find((candidate) => candidate.slotId === slotId);
    if (!slot || !canSchedule || slot.reschedulable === false || !actions.move) return 'ignored';
    if (today !== '' && day < today) {
      setPastDayNotice(true);
      return 'ignored';
    }
    setPastDayNotice(false);
    if (slot.date === day) return 'ignored';
    const status =
      days.flatMap((d) => d.posts).find((post) => post.id === slot.slotId)?.status ?? '';
    // Drawn on its new day at once; the server's answer confirms or reverts it.
    moveTo(slot.slotId, day);
    void commitMove(slot, day, status);
    return 'moved';
  };

  const { dragging } = useCalendarDrag(pageRef, {
    onDrop,
    onRefused: () => setPastDayNotice(true),
    describe: (payload: string, day: string, state: DropState) => {
      if (state === 'past') return t['calendar.drag.pastDay'] ?? '';
      const slot = payload.startsWith('slot:')
        ? slots.find((candidate) => candidate.slotId === payload.slice('slot:'.length))
        : undefined;
      return whenOf(day, slot?.time ?? '');
    },
  });

  /** B7 — only a post that can still move can be dragged, and only by a scheduler. */
  const postDragData = (post: PostRecord): string | undefined => {
    if (!canSchedule) return undefined;
    const slot = slots.find((candidate) => candidate.slotId === post.id);
    return slot && slot.reschedulable !== false ? `slot:${post.id}` : undefined;
  };

  // §8.2 — the phone's strip: the next 14 days from today, in the workspace's zone.
  const stripDays = today ? stripDayKeys(today).map((key) => ({ key, ...dayParts(key) })) : [];

  const filterQuery = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value !== ''),
  ).toString();

  const goTo = (target: string) => {
    startTransition(() =>
      router.push(`/${locale}/calendar?month=${target}${filterQuery ? `&${filterQuery}` : ''}`),
    );
  };

  const openSlot = slots.find((slot) => slot.slotId === openSlotId) ?? null;

  /*
   * A POST CHIP CARRIES THE SLOT ID, so opening one is a lookup rather than a
   * search through the rendered days. `PostRecord.id` is the slot's id for
   * exactly this reason — the chip is a plan, not a draft.
   */
  const onOpenPost = (post: PostRecord) => setOpenSlotId(post.id);

  const quotaText =
    quotaLimit === null
      ? `${t['calendar.quota']}: ${quotaUsed} · ${t['calendar.quotaUnlimited']}`
      : `${t['calendar.quota']}: ${quotaUsed} / ${quotaLimit}`;

  /*
   * D-468 batch 2 — THE VIEW AND THE WEEK ARE THE PROTOTYPE'S: Month, Week or
   * Agenda from its switch, and in the week view previous / next walk the
   * month's weeks before they leave it. A phone opens on the agenda (D-306),
   * and only a wide screen draws the prototype's own agenda list; below 768px
   * the product's phone agenda stays (D-468 (b)).
   */
  const [view, setView] = useState<CalendarViewMode>('month');
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)');
    const apply = () => setWide(query.matches);
    apply();
    if (!query.matches) setView('agenda');
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);
  const monthWeeks = Math.max(1, Math.ceil(days.length / 7));
  const weekCount = Array.from({ length: monthWeeks }, (_unused, index) =>
    days.slice(index * 7, index * 7 + 7),
  ).filter((week) => week.some((day) => day.inCurrentPeriod)).length;
  const [shownWeek, setShownWeek] = useState(weekIndex);
  const nextWeekAt = useRef<'first' | 'last' | null>(null);
  useEffect(() => {
    const at = nextWeekAt.current;
    nextWeekAt.current = null;
    setShownWeek(at === 'last' ? Math.max(0, weekCount - 1) : at === 'first' ? 0 : weekIndex);
  }, [month, weekCount, weekIndex]);

  const kindOf = (post: PostRecord): CalendarPostKind => {
    if (post.status === 'DRAFT') return post.approval === 'NEEDS_APPROVAL' ? 'review' : 'draft';
    if (post.status === 'PUBLISHED' || post.status === 'PARTIALLY_PUBLISHED') return 'pub';
    if (post.status === 'FAILED') return 'failed';
    return 'sched';
  };
  const statusLabelOf = (post: PostRecord): string =>
    kindOf(post) === 'review'
      ? (t['content.status.IN_REVIEW'] ?? '')
      : (t[`content.status.${post.status}`] ?? post.status);
  const channelName = (key: string) => t[`content.platform.${key}`] ?? key;
  const dayFormat = (dayKey: string, options: Intl.DateTimeFormatOptions) => {
    const [year, monthNumber, dayNumber] = dayKey.split('-').map(Number);
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en', {
      ...options,
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(year ?? 0, (monthNumber ?? 1) - 1, dayNumber ?? 1)));
  };

  const protoDays: ProtoCalendarDay[] = shownDays.map((day) => ({
    key: day.key,
    n: dayFormat(day.key, { day: 'numeric' }),
    longLabel:
      locale === 'ar'
        ? dayFormat(day.key, { day: 'numeric', month: 'long' })
        : dayFormat(day.key, { month: 'long', day: 'numeric' }),
    short:
      locale === 'ar'
        ? dayFormat(day.key, { day: 'numeric', month: 'long' })
        : dayFormat(day.key, { month: 'short', day: 'numeric' }),
    inMonth: day.inCurrentPeriod,
    isToday: day.isToday,
    isPast: day.isPast === true,
    markers: day.markers ?? [],
    posts: day.posts.map((post): ProtoCalendarPost => {
      const slot = slots.find((candidate) => candidate.slotId === post.id);
      const channels = (slot?.channels ?? post.platforms).map((key) => ({
        key,
        name: channelName(key),
      }));
      return {
        id: post.id,
        itemId: slot?.contentItemId ?? '',
        title: post.caption,
        titleDir: post.captionDirection,
        kind: kindOf(post),
        statusLabel: statusLabelOf(post),
        hhmm: slot?.time ?? post.whenLabel,
        channels,
        art: { src: post.mediaSrc ?? null, seed: post.mediaSeed },
        meta: [channels.map((channel) => channel.name).join(' · '), slot?.campaignName]
          .filter(Boolean)
          .join(' · '),
        caption: slot?.previewBody ?? '',
        canMove: canSchedule && slot?.reschedulable !== false && actions.move !== undefined,
        dragData: postDragData(post),
      };
    }),
  }));

  const filterHref = (changes: Partial<typeof filters>) => {
    const next = new URLSearchParams(
      Object.entries({ ...filters, ...changes }).filter(([, value]) => value !== ''),
    );
    next.set('month', month);
    return `/${locale}/calendar?${next.toString()}`;
  };

  const emptyAction = canSchedule ? (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '6px' }}>
      <button
        type="button"
        className="bsp-btn bsp-sm"
        data-testid="calendar-empty-schedule"
        onClick={() => setScheduling(true)}
      >
        {t['calendar.emptySchedule']}
      </button>
      <Link
        href={`/${locale}/content/compose`}
        className="bsp-btn bsp-sm bsp-sec"
        data-testid="calendar-empty-create"
      >
        {t['calendar.emptyCreate']}
      </Link>
    </span>
  ) : undefined;

  return (
    <div
      ref={pageRef}
      data-testid="calendar-page"
      style={{ display: 'flex', flexDirection: 'column', gap: '22px', minInlineSize: 0 }}
    >
      {pastDayNotice ? (
        <Banner tone="warning" testId="calendar-past-day">
          {t['calendar.pastDay']}
        </Banner>
      ) : null}
      <PrototypeCalendar
        labels={{
          calendarLabel: labels.calendarLabel,
          previous: labels.previous,
          next: labels.next,
          today: labels.today,
          month: labels.monthView,
          week: labels.weekView,
          agenda: labels.agendaView,
          newPostDay: t['calendar.newPostDay'] ?? '',
          readyTitle: t['calendar.readyTitle'] ?? '',
          noReady: t['calendar.noReady'] ?? '',
          agendaEmpty: t['calendar.agendaEmpty'] ?? '',
          edit: t['calendar.pop.edit'] ?? '',
          open: t['calendar.pop.open'] ?? '',
          move: t['calendar.pop.move'] ?? '',
          duplicate: t['calendar.pop.duplicate'] ?? '',
          details: t['calendar.pop.details'] ?? '',
          cancel: t['calendar.cancelMove'] ?? '',
          pickDay: t['calendar.pickDay'] ?? '{title}',
          hint: canSchedule ? (t['calendar.hint'] ?? '') : '',
          legend: (
            [
              ['sched', 'SCHEDULED'],
              ['review', 'IN_REVIEW'],
              ['draft', 'DRAFT'],
              ['pub', 'PUBLISHED'],
              ['failed', 'FAILED'],
            ] as const
          ).map(([kind, status]) => ({ kind, label: t[`content.status.${status}`] ?? status })),
        }}
        periodLabel={periodLabel}
        weekLabel={(week) =>
          `${periodLabel} · ${(t['calendar.weekN'] ?? '{n}').replace('{n}', String(week))}`
        }
        weekdays={weekdays}
        days={protoDays}
        view={view}
        onView={setView}
        weekIndex={shownWeek}
        onWeekIndex={setShownWeek}
        isAway={month !== currentMonth}
        busy={pending}
        onPrevious={() => {
          if (view === 'week') nextWeekAt.current = 'last';
          goTo(previousMonth);
        }}
        onNext={() => {
          if (view === 'week') nextWeekAt.current = 'first';
          goTo(nextMonth);
        }}
        onToday={() => goTo(currentMonth)}
        channelChips={(filterOptions?.platforms ?? []).map((platform) => ({
          key: platform.key,
          name: platform.label,
          on: filters.platform === platform.key,
          href: filterHref({ platform: filters.platform === platform.key ? '' : platform.key }),
        }))}
        headerAction={
          /*
            Review of #67 — the prototype's head row has neither the filter
            row nor "Add to calendar": the brand, campaign and status filters,
            the time zone and the count are under "Filters", and adding to the
            calendar is under "⋯". Nothing is removed. The two stay together at
            the row's end when it wraps, so the panels open over the month.
          */
          <span className="bsp-cal-acts">
            <FiltersDisclosure
              label={t['content.p.filters'] ?? ''}
              active={[filters.brand, filters.campaign, filters.status].filter(Boolean).length}
              testId="calendar-filters-toggle"
              wide
            >
              <div className="bsp-cal-filters" data-testid="calendar-filters">
                {filterOptions ? (
                  <form
                    method="get"
                    action={`/${locale}/calendar`}
                    data-testid="calendar-filter-form"
                    className="bsp-cal-filter-form"
                  >
                    <input type="hidden" name="month" value={month} />
                    {filters.platform ? (
                      <input type="hidden" name="platform" value={filters.platform} />
                    ) : null}
                    <FilterSelect
                      id="calendar-filter-brand"
                      name="brand"
                      label={t['calendar.filter.brand'] ?? ''}
                      allLabel={t['calendar.filter.all'] ?? ''}
                      value={filters.brand}
                      options={filterOptions.brands.map((b) => ({ value: b.id, label: b.name }))}
                    />
                    <FilterSelect
                      id="calendar-filter-campaign"
                      name="campaign"
                      label={t['calendar.filter.campaign'] ?? ''}
                      allLabel={t['calendar.filter.all'] ?? ''}
                      value={filters.campaign}
                      options={filterOptions.campaigns.map((c) => ({ value: c.id, label: c.name }))}
                    />
                    <FilterSelect
                      id="calendar-filter-status"
                      name="status"
                      label={t['calendar.filter.status'] ?? ''}
                      allLabel={t['calendar.filter.all'] ?? ''}
                      value={filters.status}
                      options={filterOptions.statuses.map((st) => ({
                        value: st.key,
                        label: st.label,
                      }))}
                    />
                    <button
                      type="submit"
                      className="bsp-btn bsp-sm bsp-sec"
                      data-testid="calendar-filter-apply"
                    >
                      {t['calendar.filter.apply']}
                    </button>
                  </form>
                ) : null}
                {/*
                  THE ZONE IS STATED, ALWAYS. Every time on this screen is a
                  wall-clock in the workspace's zone, and a calendar that does not
                  say which zone it means is a calendar people misread — which is
                  the whole reason the slot stores the intent (AC-14.2, AC-14.3).
                */}
                <span data-testid="calendar-timezone" className="bsp-cal-note">
                  {t['calendar.timezoneNote']}: {timezone}
                </span>
                <span data-testid="calendar-quota" className="bsp-cal-note">
                  {quotaText}
                </span>
              </div>
            </FiltersDisclosure>
            {canSchedule ? (
              <MoreDisclosure
                label={t['calendar.scheduleSubmit'] ?? ''}
                testId="calendar-more"
                align="end"
                closeOnPick
              >
                <button
                  type="button"
                  className="bsp-btn bsp-sm"
                  data-testid="calendar-schedule-open"
                  onClick={() => setScheduling(true)}
                >
                  {t['calendar.scheduleSubmit']}
                </button>
              </MoreDisclosure>
            ) : null}
          </span>
        }
        newPostHref={canCreate ? (dayKey) => `/${locale}/content/compose?date=${dayKey}` : null}
        drafts={
          canSchedule
            ? drafts.map((draft) => ({
                id: draft.id,
                title: draft.title,
                art: { src: null, seed: (draft.id.charCodeAt(0) % 6) as MediaSeed },
              }))
            : null
        }
        onPlaceDraft={(itemId, dayKey) => openScheduleFor(itemId, dayKey)}
        editHref={(post) => `/${locale}/content/compose?item=${post.itemId}`}
        duplicate={canCreate && actions.duplicate ? { action: actions.duplicate, locale } : null}
        onMove={(slotId, dayKey) => {
          onDrop(`slot:${slotId}`, dayKey);
        }}
        onPastDay={() => setPastDayNotice(true)}
        onOpenDetails={(slotId) => setOpenSlotId(slotId)}
        dropTargets={canSchedule}
        wideAgendaShown={wide}
        phone={
          <CalendarAgenda
            days={shownDays}
            labels={{ ...labels, postsOnDay: (count) => `${count} ${postsOnDayLabel}` }}
            onOpenPost={onOpenPost}
            postDragData={canSchedule ? postDragData : undefined}
            emptyAction={emptyAction}
          />
        }
        dropStrip={
          canSchedule && dragging && stripDays.length > 0 ? (
            <div className="bs-narrow-only">
              <CalendarDropStrip days={stripDays} title={t['calendar.drag.strip'] ?? ''} />
            </div>
          ) : null
        }
      />

      {/* §8.2 — the hint under the phone's list: a long-press lifts a post. */}
      {canSchedule ? (
        <p className="bs-narrow-only" data-testid="calendar-move-note" style={{ margin: 0 }}>
          <span className="bsp-cal-note">{t['calendar.moveFromPost']}</span>
        </p>
      ) : null}

      {/*
        D-290 — ONE QUIET LINE, NEVER A POPUP: a weekday nothing went on for
        the last whole weeks, from real slots. Nothing is said when the
        calendar is too quiet or too sparse for it to mean anything.
      */}
      {gaps.length > 0 ? (
        <p data-testid="calendar-gap" className="bsp-cal-gap">
          <b>{t['calendar.gap.title']}</b>
          <span>{gaps.join(' ')}</span>
          {copilotHref ? (
            <CopilotLink href={copilotHref} testId="calendar-gap-copilot">
              {t['calendar.gap.ask']}
            </CopilotLink>
          ) : null}
        </p>
      ) : null}

      {/*
        D-290 — THE UNSCHEDULED TRAY: posts that could go on the calendar and
        are not on it. Drag one onto a day (desktop) or press Schedule — the
        keyboard and touch path, never an afterthought. Drawn as the
        prototype's card and rows (D-468 (c)): the prototype has no tray.
      */}
      {canSchedule ? (
        <section
          data-testid="calendar-tray"
          aria-labelledby="calendar-tray-title"
          className="bsp-xcard bsp-cal-tray"
        >
          <h2 id="calendar-tray-title" className="bsp-sech">
            {(t['calendar.tray.title'] ?? '{count}').replace('{count}', String(drafts.length))}
          </h2>
          {drafts.length === 0 ? (
            <p className="bsp-xdesc">{t['calendar.tray.empty']}</p>
          ) : (
            <>
              <p className="bsp-xdesc">{t['calendar.tray.hint']}</p>
              <ul className="bsp-cal-tray-list">
                {(trayExpanded ? drafts : drafts.slice(0, TRAY_PREVIEW)).map((draft) => (
                  <li
                    key={draft.id}
                    // B7 / §8.2 — `item:` says a tray draft; a post already
                    // planned carries `slot:`. Dropping one opens the dialog.
                    data-drag-payload={`item:${draft.id}`}
                    data-pid={draft.id}
                    data-testid={`calendar-tray-${draft.id}`}
                    className="bsp-cal-tray-row"
                  >
                    <span className="bsp-cal-popx-art">
                      <AbstractMedia seed={(draft.id.charCodeAt(0) % 6) as MediaSeed} alt="" />
                    </span>
                    <span className="bsp-cal-tray-copy">
                      <strong dir="auto" className="bsp-cal-atitle">
                        {draft.title}
                      </strong>
                      <span className="bsp-cal-meta">
                        {[draft.channels.map(channelName).join(' · '), draft.campaignName]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {draft.status ? (
                      <span
                        className={`bsp-xstatus ${draft.status === 'APPROVED' ? '' : draft.status === 'FAILED' ? 'bsp-bad' : 'bsp-neu'}`}
                      >
                        {t[`content.status.${draft.status}`] ?? draft.status}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="bsp-btn bsp-sm bsp-sec"
                      data-testid={`calendar-tray-schedule-${draft.id}`}
                      onClick={() => openScheduleFor(draft.id)}
                    >
                      {t['calendar.scheduleSubmit']}
                    </button>
                  </li>
                ))}
              </ul>
              {drafts.length > TRAY_PREVIEW ? (
                <div>
                  <button
                    type="button"
                    className="bsp-btn bsp-sm bsp-ghost"
                    aria-expanded={trayExpanded}
                    data-testid="calendar-tray-toggle"
                    onClick={() => setTrayExpanded((open) => !open)}
                  >
                    {trayExpanded
                      ? t['calendar.tray.showFewer']
                      : (t['calendar.tray.showAll'] ?? '{count}').replace(
                          '{count}',
                          String(drafts.length),
                        )}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {/* ------------------------------------------- schedule a draft --- */}
      <Dialog
        open={scheduling}
        onClose={() => setScheduling(false)}
        title={t['calendar.scheduleTitle'] ?? ''}
        description={`${t['calendar.timezoneNote']}: ${timezone}`}
        closeLabel={t['common.close'] ?? 'Close'}
        testId="calendar-schedule-dialog"
      >
        {drafts.length === 0 ? (
          <StateMessage
            title={t['calendar.noSchedulable'] ?? ''}
            description={t['calendar.noSchedulableBody'] ?? ''}
          />
        ) : (
          <form action={actions.schedule} style={{ display: 'grid', gap: spacingTokens.md }}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="month" value={month} />

            <Field label={t['calendar.scheduleDraft'] ?? ''} htmlFor="schedule-item">
              <select
                className="bs-control"
                id="schedule-item"
                name="contentItemId"
                required
                value={scheduleItem}
                onChange={(event) => setScheduleItem(event.target.value)}
                data-testid="schedule-item"
                style={inputStyle()}
              >
                {drafts.map((draft) => (
                  <option key={draft.id} value={draft.id}>
                    {draft.title}
                  </option>
                ))}
              </select>
            </Field>

            {/*
              NATIVE date AND time INPUTS, deliberately. Each is localised by
              the browser, keyboard-operable, and announced correctly by screen
              readers — everything a hand-rolled picker would have to re-earn,
              and the reason WCAG 2.2 AA is cheaper to keep here than to rebuild.
            */}
            <div className="bs-form-row">
              <Field label={t['calendar.scheduleDate'] ?? ''} htmlFor="schedule-date">
                <input
                  className="bs-control"
                  id="schedule-date"
                  name="date"
                  type="date"
                  required
                  value={scheduleDate}
                  onChange={(event) => chooseScheduleDate(event.target.value)}
                  {...(today ? { min: today } : {})}
                  data-testid="schedule-date"
                  style={inputStyle()}
                />
              </Field>
              <Field label={t['calendar.scheduleTime'] ?? ''} htmlFor="schedule-time">
                <input
                  className="bs-control"
                  id="schedule-time"
                  name="time"
                  type="time"
                  required
                  value={scheduleTime}
                  onChange={(event) => setScheduleTime(event.target.value)}
                  data-testid="schedule-time"
                  style={inputStyle()}
                />
              </Field>
            </div>
            {/*
              G6 (D-329) — THE COUNTRY'S SUGGESTED TIMES, one tap each. Said as
              "Suggested time", never "best time": nothing here was measured.
            */}
            {suggestedTimes.length > 0 ? (
              <div
                role="group"
                aria-label={t['calendar.suggestedTime'] ?? ''}
                data-testid="schedule-suggested"
                style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.375rem' }}
              >
                <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                  {t['calendar.suggestedTime']}
                </span>
                {suggestedTimes.map((time) => (
                  <button
                    key={time}
                    type="button"
                    className={buttonClass(scheduleTime === time ? 'primary' : 'neutral', 'sm')}
                    data-testid={`schedule-suggested-${time}`}
                    aria-pressed={scheduleTime === time}
                    onClick={() => setScheduleTime(time)}
                  >
                    {time}
                  </button>
                ))}
              </div>
            ) : null}

            <div>
              <button
                type="submit"
                data-testid="schedule-submit"
                className={buttonClass('primary')}
              >
                {t['calendar.scheduleSubmit']}
              </button>
            </div>
          </form>
        )}
      </Dialog>

      {/*
        D-290 — THE POST DRAWER: a side sheet over the calendar rather than a
        modal in the middle of it, so the month stays readable behind it.
      */}
      <SideSheet
        open={openSlot !== null}
        onClose={() => setOpenSlotId(null)}
        title={openSlot?.title ?? ''}
        description={t['calendar.slotDialogHint'] ?? ''}
        closeLabel={t['common.close'] ?? 'Close'}
        testId="calendar-slot-dialog"
      >
        {openSlot ? (
          <div style={{ display: 'grid', gap: spacingTokens.md }}>
            {openSlot.previewPlatform ? (
              <VariantPreview
                locale={locale}
                platformKey={openSlot.previewPlatform}
                body={openSlot.previewBody ?? ''}
                hashtags={[]}
                media={openSlot.previewMedia ?? []}
                accountName={openSlot.campaignName ?? openSlot.title}
                accountHandle=""
                status="SCHEDULED"
                approval="NOT_REQUIRED"
                labels={previewLabels(t)}
                testId="calendar-drawer-preview"
              />
            ) : null}
            <p data-testid="calendar-slot-when" style={{ margin: 0, ...typographyTokens.label }}>
              {t['calendar.scheduledFor']}: {openSlot.date} {openSlot.time} · {timezone}
            </p>
            {/*
              WHAT THE POST ACTUALLY IS, before what can be done to it.
              A definition list rather than a sentence, because a reader
              scanning for one fact — did it go out? — should not have to read
              the other three. Every row is omitted when it has no value: a
              post in no campaign has no campaign row, which is the honest
              rendering of "none" (D-184).
            */}
            <dl
              data-testid="calendar-slot-facts"
              style={{ margin: 0, display: 'grid', gap: spacingTokens['2xs'] }}
            >
              <SlotFact term={t['calendar.channels'] ?? ''} value={openSlot.channels.join(' · ')} />
              {openSlot.campaignName ? (
                <SlotFact
                  term={t['calendar.campaign'] ?? ''}
                  value={openSlot.campaignName}
                  testId="calendar-slot-campaign"
                />
              ) : null}
              <SlotFact
                term={t['calendar.publishState'] ?? ''}
                value={openSlot.statusLabel}
                testId="calendar-slot-status"
              />
              {openSlot.approvalLabel ? (
                <SlotFact
                  term={t['calendar.approvalState'] ?? ''}
                  value={openSlot.approvalLabel}
                  testId="calendar-slot-approval"
                />
              ) : null}
              {openSlot.mediaCount > 0 ? (
                <SlotFact
                  term={t['calendar.media'] ?? ''}
                  value={String(openSlot.mediaCount)}
                  testId="calendar-slot-media"
                />
              ) : null}
              {openSlot.readiness ? (
                <SlotFact
                  term={t['calendar.readiness'] ?? ''}
                  value={openSlot.readiness.label}
                  testId="calendar-slot-readiness"
                />
              ) : null}
              {openSlot.openNotes ? (
                <SlotFact
                  term={t['calendar.drawer.notes'] ?? ''}
                  value={String(openSlot.openNotes)}
                  testId="calendar-slot-notes"
                />
              ) : null}
            </dl>

            {/*
              WHAT IS IN THE WAY, AND WHERE TO FIX IT.

              `StateMessage` rather than a bespoke panel — the design system's
              own inline notice, already used on this screen for the empty
              draft list (UI-fidelity contract §6.2 rule 4: reuse before
              creating). NOT a colour literal and not a new treatment.

              One line per blocked channel, naming the channel and what is
              wrong with it. The account's own name is appended only when the
              server sent one, which it does only for a reader holding
              `integrations.read`.
            */}
            {openSlot.readiness && openSlot.readiness.channels.length > 0 ? (
              <Banner tone="warning" testId="calendar-slot-readiness-detail">
                <ul style={{ margin: 0, paddingInlineStart: spacingTokens.md }}>
                  {openSlot.readiness.channels.map((channel) => (
                    <li key={channel.platformKey}>
                      {channel.accountName
                        ? `${channel.platformKey} · ${channel.label} — ${channel.accountName}`
                        : `${channel.platformKey} · ${channel.label}`}
                      {channel.explanation ? (
                        <span style={{ display: 'block' }}>{channel.explanation}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Banner>
            ) : null}

            {canSchedule && openSlot.reschedulable !== false ? (
              <form action={actions.reschedule} style={{ display: 'grid', gap: spacingTokens.md }}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="month" value={month} />
                <input type="hidden" name="slotId" value={openSlot.slotId} />
                <div className="bs-form-row">
                  <Field label={t['calendar.scheduleDate'] ?? ''} htmlFor="reschedule-date">
                    <input
                      className="bs-control"
                      id="reschedule-date"
                      name="date"
                      type="date"
                      required
                      defaultValue={openSlot.date}
                      {...(today ? { min: today } : {})}
                      data-testid="reschedule-date"
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label={t['calendar.scheduleTime'] ?? ''} htmlFor="reschedule-time">
                    <input
                      className="bs-control"
                      id="reschedule-time"
                      name="time"
                      type="time"
                      required
                      defaultValue={openSlot.time}
                      data-testid="reschedule-time"
                      style={inputStyle()}
                    />
                  </Field>
                </div>
                <div style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
                  <button
                    type="submit"
                    data-testid="reschedule-submit"
                    className={buttonClass('primary')}
                  >
                    {t['calendar.rescheduleSubmit']}
                  </button>
                </div>
              </form>
            ) : null}

            <div style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
              <a
                href={`/${locale}/content/compose?item=${openSlot.contentItemId}`}
                data-testid="calendar-open-studio"
                className={buttonClass('neutral')}
              >
                {t['calendar.openInStudio']}
              </a>
              {/*
                D-290 — REQUEST APPROVAL from where the post is being planned:
                the one submit action, returning to this month. Offered for a
                DRAFT only; changes requested are answered in the editor, where
                the reviewer's note is.
              */}
              {canSubmit && actions.submitForReview && openSlot.itemStatus === 'DRAFT' ? (
                <form action={actions.submitForReview}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="month" value={month} />
                  <input type="hidden" name="returnTo" value="/calendar" />
                  <input type="hidden" name="itemId" value={openSlot.contentItemId} />
                  <button
                    type="submit"
                    data-testid="calendar-request-approval"
                    className={buttonClass('neutral')}
                  >
                    {t['calendar.drawer.requestApproval']}
                  </button>
                </form>
              ) : null}
              {/* B7 — only a plan that has not started publishing can be taken off. */}
              {canSchedule && openSlot.reschedulable !== false ? (
                <form action={actions.cancel}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="month" value={month} />
                  <input type="hidden" name="slotId" value={openSlot.slotId} />
                  <button
                    type="submit"
                    data-testid="calendar-cancel-submit"
                    className={buttonClass('neutral')}
                  >
                    {t['calendar.cancelSubmit']}
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        ) : null}
      </SideSheet>
    </div>
  );
}

/** How many tray rows show before "Show all" — the calendar stays in reach. */
const TRAY_PREVIEW = 8;

/**
 * One filter: a native select drawn as the prototype's `.chip` (D-468 (c) — the
 * prototype filters by channel only, with chips). The label stays for screen
 * readers; the chip carries the choice.
 */
function FilterSelect({
  id,
  name,
  label,
  allLabel,
  value,
  options,
}: {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly allLabel: string;
  readonly value: string;
  readonly options: readonly { value: string; label: string }[];
}) {
  return (
    <label htmlFor={id} className="bsp-cal-filter">
      <span className="bsp-cal-filter-label">{label}</span>
      <select
        className="bs-control bsp-chip bsp-cal-select"
        id={id}
        name={name}
        defaultValue={value}
        data-testid={id}
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One `term: value` row in the slot dialog's fact list. */
function SlotFact({
  term,
  value,
  testId,
}: {
  readonly term: string;
  readonly value: string;
  readonly testId?: string;
}) {
  return (
    <div style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
      <dt style={{ ...typographyTokens.caption, color: colorTokens.textMuted, margin: 0 }}>
        {term}
      </dt>
      <dd
        data-testid={testId}
        style={{ ...typographyTokens.bodySm, color: colorTokens.textPrimary, margin: 0 }}
      >
        {value}
      </dd>
    </div>
  );
}
