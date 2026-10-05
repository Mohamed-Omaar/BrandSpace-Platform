'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { AbstractMedia, AssetMedia, SegmentPill, type MediaSeed } from '@brandspace/ui';

/**
 * THE CALENDAR, PORTED FROM `prototype-2026-09-27` (D-468, batch 2).
 *
 * `Main.dc.html` lines 599–660: the head row (previous, next, the month, Today
 * when away, the channel chips, the Month / Week / Agenda switch), the month
 * card of `.cal` days with their `.calchip` posts, the post's glass popover
 * (Edit, Move to another day, Duplicate), an empty day's popover (+ New post
 * on this day, Drafts without a date), the move banner, the week and agenda
 * views, and the legend with its hint. The stylesheet is §3-CAL of
 * `@brandspace/ui/prototype.css`.
 *
 * PRESENTATIONAL. It renders the days it is handed and reports what was asked
 * for; scheduling, moving, duplicating and the post drawer stay in
 * `CalendarView`, which owns the actions, so the rules (F2, the quota, the
 * approval gate, B-4, BrandScope, the audit) are exactly what they were.
 *
 * BELOW 768px the product keeps its own phone layout (D-468 (b)): the grid is
 * not drawn and the caller's `phone` agenda stands in for it.
 */

export type CalendarPostKind = 'draft' | 'review' | 'sched' | 'pub' | 'failed';

export interface ProtoCalendarPost {
  /** The slot's id — what the drawer and a move address. */
  readonly id: string;
  readonly itemId: string;
  readonly title: string;
  readonly titleDir?: 'rtl' | 'ltr' | undefined;
  readonly kind: CalendarPostKind;
  readonly statusLabel: string;
  /** The slot's local `HH:MM`, as the prototype prints it. */
  readonly hhmm: string;
  readonly channels: readonly { readonly key: string; readonly name: string }[];
  readonly art: {
    readonly src: string | null;
    readonly seed: MediaSeed;
  };
  /** The popover's meta line: channels and the campaign. */
  readonly meta: string;
  /** The popover's two lines of caption. */
  readonly caption: string;
  /** A post that may still move, for a member who may move it. */
  readonly canMove: boolean;
  readonly dragData?: string | undefined;
}

export interface ProtoCalendarDay {
  readonly key: string;
  /** The day number, Western digits (CLAUDE.md §4). */
  readonly n: string;
  /** "October 13" / "13 أكتوبر" — the day's popover and its accessible name. */
  readonly longLabel: string;
  /** "Oct 13" / "13 أكتوبر" — the agenda's day column. */
  readonly short: string;
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly isPast: boolean;
  readonly posts: readonly ProtoCalendarPost[];
  readonly markers: readonly {
    readonly label: string;
    readonly kind: string;
    readonly href?: string | undefined;
  }[];
}

export interface ProtoCalendarLabels {
  readonly calendarLabel: string;
  readonly previous: string;
  readonly next: string;
  readonly today: string;
  readonly month: string;
  readonly week: string;
  readonly agenda: string;
  readonly newPostDay: string;
  readonly readyTitle: string;
  readonly noReady: string;
  readonly agendaEmpty: string;
  readonly edit: string;
  readonly open: string;
  readonly move: string;
  readonly duplicate: string;
  readonly details: string;
  readonly cancel: string;
  /** "Pick a new day for “{title}”" */
  readonly pickDay: string;
  readonly hint: string;
  readonly legend: readonly { readonly kind: CalendarPostKind; readonly label: string }[];
}

export type CalendarViewMode = 'month' | 'week' | 'agenda';

/** The prototype's channel marks (`P` in `Main.dc.html`), at 11px. */
const CHANNEL_PATHS: Readonly<Record<string, string>> = {
  instagram:
    'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077',
  facebook:
    'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
  tiktok:
    'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
  linkedin:
    'M8 6V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1h4a2 2 0 0 1 2 2v4H2V8a2 2 0 0 1 2-2h4zm2 0h4V5h-4v1zM2 13.5h8.5V15h3v-1.5H22V19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.5z',
  // Round 4 — the prototype has no X channel; X is drawn with its real mark
  // (the design system's `platform-icons.tsx`), never the blue fallback square.
  x: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
};

export function ChannelMark({
  channel,
  size = 11,
  label = true,
}: {
  readonly channel: { readonly key: string; readonly name: string };
  readonly size?: number;
  /** In a control already named by its channel, the mark is decoration. */
  readonly label?: boolean;
}) {
  const path = CHANNEL_PATHS[channel.key];
  if (!path) {
    // The prototype's own fallback for a channel it has no mark for.
    return (
      <span
        className="bsp-cal-nomark"
        {...(label ? { role: 'img', 'aria-label': channel.name } : { 'aria-hidden': true })}
      />
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      {...(label ? { role: 'img', 'aria-label': channel.name } : { 'aria-hidden': true })}
    >
      <path d={path} />
    </svg>
  );
}

/** A post's picture: its own cover when it has one, the abstract tile when not. */
export function PostArt({ art }: { readonly art: ProtoCalendarPost['art'] }) {
  return art.src ? <AssetMedia src={art.src} alt="" /> : <AbstractMedia seed={art.seed} alt="" />;
}

function ChannelLine({ post, withNames }: { post: ProtoCalendarPost; withNames?: boolean }) {
  return (
    <span className="bsp-cal-meta">
      <span className="bsp-cal-marks">
        {post.channels.map((channel) => (
          <ChannelMark key={channel.key} channel={channel} />
        ))}
      </span>
      {withNames ? (
        <span>
          {post.channels.map((channel) => channel.name).join(' · ')} ·{' '}
          <span className="bsp-ltr">{post.hhmm}</span>
        </span>
      ) : (
        <span className="bsp-ltr">{post.hhmm}</span>
      )}
    </span>
  );
}

const XSTATUS: Record<CalendarPostKind, string> = {
  draft: 'bsp-neu',
  review: 'bsp-warn',
  sched: 'bsp-info',
  pub: '',
  failed: 'bsp-bad',
};

export function PrototypeCalendar({
  labels,
  periodLabel,
  weekLabel,
  weekdays,
  days,
  view,
  onView,
  weekIndex,
  onWeekIndex,
  isAway,
  busy,
  onPrevious,
  onNext,
  onToday,
  channelChips,
  headerAction,
  filters,
  newPostHref,
  drafts,
  onPlaceDraft,
  editHref,
  duplicate,
  onMove,
  onPastDay,
  onOpenDetails,
  dropTargets,
  phone,
  wideAgendaShown,
  dropStrip,
  children,
}: {
  readonly labels: ProtoCalendarLabels;
  readonly periodLabel: string;
  /** "October 2026 · week 3" — the head's label in the week view. */
  readonly weekLabel: (week: number) => string;
  readonly weekdays: readonly string[];
  readonly days: readonly ProtoCalendarDay[];
  readonly view: CalendarViewMode;
  readonly onView: (view: CalendarViewMode) => void;
  readonly weekIndex: number;
  readonly onWeekIndex: (index: number) => void;
  readonly isAway: boolean;
  readonly busy: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly onToday: () => void;
  readonly channelChips: readonly {
    readonly key: string;
    readonly name: string;
    readonly on: boolean;
    readonly href: string;
  }[];
  /** The product's Schedule button, after the switch (D-290). */
  readonly headerAction?: ReactNode;
  /** The product's filter row — brand, campaign, status, the zone and quota (D-290). */
  readonly filters?: ReactNode;
  /** Where "+ New post on this day" goes, or null for a member who may not create. */
  readonly newPostHref: ((dayKey: string) => string) | null;
  /** "Drafts without a date", or null for a member who may not schedule. */
  readonly drafts:
    | readonly {
        readonly id: string;
        readonly title: string;
        readonly art: ProtoCalendarPost['art'];
      }[]
    | null;
  readonly onPlaceDraft: (itemId: string, dayKey: string) => void;
  readonly editHref: (post: ProtoCalendarPost) => string;
  /** Duplicate posts the existing action; null for a member who may not create. */
  readonly duplicate: {
    readonly action: (formData: FormData) => Promise<void>;
    readonly locale: string;
  } | null;
  /** "Move to another day", then a day: the caller's move. */
  readonly onMove: (slotId: string, dayKey: string) => void;
  readonly onPastDay: () => void;
  readonly onOpenDetails: (slotId: string) => void;
  /** §8.2 — each day takes a dragged post; only for a member who may schedule. */
  readonly dropTargets: boolean;
  /** The product's phone agenda, drawn instead of the grid below 768px. */
  readonly phone: ReactNode;
  /** The agenda view on a wide screen draws the prototype's list. */
  readonly wideAgendaShown: boolean;
  readonly dropStrip?: ReactNode;
  readonly children?: ReactNode;
}) {
  const [postPop, setPostPop] = useState<string | null>(null);
  const [dayPop, setDayPop] = useState<string | null>(null);
  const [moving, setMoving] = useState<ProtoCalendarPost | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  // A popover closes on Escape and on a press anywhere outside it, as the
  // prototype's do when another surface is pressed.
  useEffect(() => {
    if (!postPop && !dayPop) return undefined;
    const close = () => {
      setPostPop(null);
      setDayPop(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.bsp-cal-pop, .bsp-cal-popx, .bsp-calchip, .bsp-cal-hit')) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [postPop, dayPop]);

  // The month's weeks: the prototype draws only the rows the month reaches.
  const weeks: ProtoCalendarDay[][] = [];
  for (let index = 0; index < days.length; index += 7) {
    const week = days.slice(index, index + 7);
    if (week.some((day) => day.inMonth)) weeks.push([...week]);
  }
  const week = weeks[Math.min(weeks.length - 1, Math.max(0, weekIndex))] ?? [];
  const agenda = days
    .filter((day) => day.inMonth)
    .flatMap((day) => day.posts.map((post) => ({ day, post })));

  const flip = (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="bsp-cal-flip"
    >
      <path d="m14.5 6-6 6 6 6" />
    </svg>
  );

  const onDayPress = (day: ProtoCalendarDay) => {
    if (!day.inMonth) return;
    if (moving) {
      if (day.isPast) {
        onPastDay();
        return;
      }
      const slotId = moving.id;
      setMoving(null);
      onMove(slotId, day.key);
      return;
    }
    setPostPop(null);
    if (day.posts.length === 0 && !day.isPast) {
      setDayPop((open) => (open === day.key ? null : day.key));
    } else {
      setDayPop(null);
    }
  };

  const dayOffersSomething = newPostHref !== null || drafts !== null;

  const dayCell = (day: ProtoCalendarDay, mode: 'month' | 'week') => {
    const canAdd = day.inMonth && !day.isPast && !moving && newPostHref !== null;
    const hit = day.inMonth && (moving !== null || dayOffersSomething);
    return (
      <div
        key={day.key}
        role="gridcell"
        className="bsp-cal-day"
        data-testid={`calendar-day-${day.key}`}
        {...(dropTargets
          ? {
              'data-drop-day': day.key,
              'data-drop-state': !day.inMonth ? 'none' : day.isPast ? 'past' : 'ok',
            }
          : {})}
        data-past={day.isPast ? 'true' : undefined}
        data-out={day.inMonth ? undefined : ''}
        data-today={day.isToday ? '' : undefined}
        data-pop={dayPop === day.key ? '' : undefined}
        data-moving={moving && day.inMonth && !day.isPast ? '' : undefined}
        aria-label={day.longLabel}
      >
        {hit ? (
          <button
            type="button"
            className="bsp-cal-hit"
            aria-label={
              moving
                ? `${labels.pickDay.replace('{title}', moving.title)} · ${day.n}`
                : `${labels.newPostDay} ${day.n}`
            }
            onClick={() => onDayPress(day)}
          />
        ) : null}
        <div className="bsp-cal-num-row">
          <span className="bsp-cal-num bsp-ltr">{day.n}</span>
          {day.isToday ? <span className="bsp-cal-today">{labels.today}</span> : null}
        </div>
        {mode === 'month'
          ? day.markers.map((marker, index) =>
              marker.href ? (
                <Link
                  key={index}
                  href={marker.href}
                  title={marker.label}
                  className="bsp-cal-hol"
                  data-testid={`calendar-marker-${day.key}-${index}`}
                  data-kind={marker.kind}
                  aria-label={`${marker.label} — ${day.longLabel}`}
                >
                  ★ {marker.label}
                </Link>
              ) : (
                <span
                  key={index}
                  title={marker.label}
                  className="bsp-cal-hol"
                  data-testid={`calendar-marker-${day.key}-${index}`}
                  data-kind={marker.kind}
                >
                  ★ {marker.label}
                </span>
              ),
            )
          : null}
        {canAdd && newPostHref ? (
          <Link
            href={newPostHref(day.key)}
            className="bsp-caladd"
            data-testid={`calendar-new-${day.key}`}
            aria-label={`${labels.newPostDay} ${day.n}`}
          >
            +
          </Link>
        ) : null}
        {day.posts.map((post) =>
          mode === 'month' ? (
            <Fragment key={post.id}>
              <button
                type="button"
                className="bsp-calchip"
                data-testid={`calendar-post-${post.id}`}
                data-k={post.kind}
                data-pid={post.id}
                {...(post.dragData
                  ? { 'data-drag-payload': post.dragData, 'data-drag-day': day.key }
                  : {})}
                aria-label={`${post.title} · ${post.channels.map((c) => c.name).join(' · ')} · ${post.hhmm} · ${post.statusLabel}`}
                aria-expanded={postPop === post.id}
                aria-haspopup="dialog"
                onClick={() => {
                  if (moving) return;
                  setDayPop(null);
                  setPostPop((open) => (open === post.id ? null : post.id));
                }}
              >
                <span className="bsp-cal-bar" />
                <span className="bsp-cal-art">
                  <PostArt art={post.art} />
                </span>
                <span className="bsp-cal-chip-text">
                  <span className="bsp-cal-chip-title" dir={post.titleDir}>
                    {post.title}
                  </span>
                  <ChannelLine post={post} />
                </span>
              </button>
              {postPop === post.id ? (
                <div
                  role="dialog"
                  aria-label={post.title}
                  className="bsp-cal-pop"
                  data-testid={`calendar-post-pop-${post.id}`}
                >
                  <span className="bsp-cal-pop-art">
                    <PostArt art={post.art} />
                  </span>
                  <span className="bsp-cal-pop-head">
                    <span className="bsp-cal-pop-title" dir={post.titleDir}>
                      {post.title}
                    </span>
                    <span className={`bsp-xstatus ${XSTATUS[post.kind]}`}>{post.statusLabel}</span>
                  </span>
                  <span className="bsp-cal-pop-meta">{post.meta}</span>
                  {post.caption ? <span className="bsp-cal-pop-cap">{post.caption}</span> : null}
                  <span className="bsp-cal-pop-acts">
                    <Link
                      href={editHref(post)}
                      className="bsp-btn bsp-sm"
                      data-testid="calendar-pop-edit"
                    >
                      {post.kind === 'pub' ? labels.open : labels.edit}
                    </Link>
                    {post.canMove ? (
                      <button
                        type="button"
                        className="bsp-btn bsp-sm bsp-sec"
                        data-testid="calendar-pop-move"
                        onClick={() => {
                          setPostPop(null);
                          setMoving(post);
                        }}
                      >
                        {labels.move}
                      </button>
                    ) : null}
                    {duplicate ? (
                      <form action={duplicate.action} style={{ display: 'contents' }}>
                        <input type="hidden" name="locale" value={duplicate.locale} />
                        <input type="hidden" name="itemId" value={post.itemId} />
                        <input type="hidden" name="token" value={`calendar:${post.id}`} />
                        <button
                          type="submit"
                          className="bsp-btn bsp-sm bsp-ghost"
                          data-testid="calendar-pop-duplicate"
                        >
                          {labels.duplicate}
                        </button>
                      </form>
                    ) : null}
                    {/* D-290 — the product's post drawer, which the prototype does not draw. */}
                    <button
                      type="button"
                      className="bsp-btn bsp-sm bsp-ghost"
                      data-testid="calendar-pop-details"
                      onClick={() => {
                        setPostPop(null);
                        onOpenDetails(post.id);
                      }}
                    >
                      {labels.details}
                    </button>
                  </span>
                </div>
              ) : null}
            </Fragment>
          ) : (
            <button
              key={post.id}
              type="button"
              className="bsp-cal-wpost"
              data-testid={`calendar-post-${post.id}`}
              data-k={post.kind}
              data-pid={post.id}
              {...(post.dragData
                ? { 'data-drag-payload': post.dragData, 'data-drag-day': day.key }
                : {})}
              aria-label={`${post.title} · ${post.hhmm} · ${post.statusLabel}`}
              onClick={() => onOpenDetails(post.id)}
            >
              <span className="bsp-cal-wpost-art">
                <PostArt art={post.art} />
              </span>
              <span className="bsp-cal-wpost-title" dir={post.titleDir}>
                {post.title}
              </span>
              <ChannelLine post={post} />
            </button>
          ),
        )}
        {mode === 'month' && dayPop === day.key ? (
          <div
            className="bsp-cal-popx"
            role="dialog"
            aria-label={day.longLabel}
            data-testid={`calendar-day-pop-${day.key}`}
          >
            <span className="bsp-cal-popx-title">{day.longLabel}</span>
            {newPostHref ? (
              <Link
                href={newPostHref(day.key)}
                className="bsp-cal-popx-new"
                data-testid="calendar-day-pop-new"
              >
                + {labels.newPostDay}
              </Link>
            ) : null}
            {drafts ? (
              <>
                <span className="bsp-cal-popx-head">{labels.readyTitle}</span>
                {drafts.map((draft) => (
                  <button
                    key={draft.id}
                    type="button"
                    className="bsp-cal-popx-row"
                    data-testid={`calendar-day-pop-draft-${draft.id}`}
                    onClick={() => {
                      setDayPop(null);
                      onPlaceDraft(draft.id, day.key);
                    }}
                  >
                    <span className="bsp-cal-popx-art">
                      <PostArt art={draft.art} />
                    </span>
                    {draft.title}
                  </button>
                ))}
                {drafts.length === 0 ? (
                  <span className="bsp-cal-popx-none">{labels.noReady}</span>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section
      ref={rootRef}
      className="bsp-cal"
      data-testid="content-calendar"
      aria-busy={busy || undefined}
    >
      <div className="bsp-cal-head">
        <button
          type="button"
          className="bsp-ibtn"
          data-testid="calendar-previous"
          aria-label={labels.previous}
          onClick={() => {
            if (view === 'week' && weekIndex > 0) onWeekIndex(weekIndex - 1);
            else onPrevious();
          }}
        >
          {flip}
        </button>
        <button
          type="button"
          className="bsp-ibtn"
          data-testid="calendar-next"
          aria-label={labels.next}
          onClick={() => {
            if (view === 'week' && weekIndex < weeks.length - 1) onWeekIndex(weekIndex + 1);
            else onNext();
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="bsp-cal-flip"
          >
            <path d="m9.5 6 6 6-6 6" />
          </svg>
        </button>
        <h2 className="bsp-cal-label" data-testid="calendar-period">
          {view === 'week' ? weekLabel(weekIndex + 1) : periodLabel}
        </h2>
        {isAway ? (
          <button
            type="button"
            className="bsp-btn bsp-sm bsp-sec"
            data-testid="calendar-today"
            onClick={onToday}
          >
            {labels.today}
          </button>
        ) : null}
        {channelChips.length > 0 ? (
          <div className="bsp-cal-pf">
            {channelChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className="bsp-chip"
                aria-pressed={chip.on}
                data-testid={`calendar-channel-${chip.key}`}
                onClick={() => router.push(chip.href)}
              >
                {CHANNEL_PATHS[chip.key] ? (
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d={CHANNEL_PATHS[chip.key]} />
                  </svg>
                ) : null}
                <span className="bsp-ltr">{chip.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div
          className="bsp-seg bsp-cal-views"
          role="group"
          aria-label={labels.calendarLabel}
          style={{ marginInlineStart: 'auto' }}
        >
          <SegmentPill selector='[aria-pressed="true"]' />
          {(
            [
              ['month', labels.month],
              ['week', labels.week],
              ['agenda', labels.agenda],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="bsp-seg-item"
              data-testid={`calendar-view-${value}`}
              aria-pressed={view === value}
              onClick={() => {
                setPostPop(null);
                setDayPop(null);
                onView(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {headerAction}
      </div>

      {moving ? (
        <div role="status" className="bsp-cal-moving" data-testid="calendar-moving">
          <span style={{ flexGrow: 1 }}>{labels.pickDay.replace('{title}', moving.title)}</span>
          <button
            type="button"
            className="bsp-btn bsp-sm bsp-sec"
            data-testid="calendar-moving-cancel"
            onClick={() => setMoving(null)}
          >
            {labels.cancel}
          </button>
        </div>
      ) : null}

      {filters}

      {view === 'agenda' ? (
        wideAgendaShown ? (
          <section className="bsp-xcard bsp-cal-agenda" data-testid="calendar-agenda">
            {agenda.map(({ day, post }) => (
              <button
                key={post.id}
                type="button"
                className="bsp-cal-arow"
                data-testid={`calendar-post-${post.id}`}
                data-pid={post.id}
                onClick={() => onOpenDetails(post.id)}
              >
                <span className="bsp-cal-aday">{day.short}</span>
                <span className="bsp-cal-aart">
                  <PostArt art={post.art} />
                </span>
                <span className="bsp-cal-acopy">
                  <span className="bsp-cal-atitle" dir={post.titleDir}>
                    {post.title}
                  </span>
                  <ChannelLine post={post} withNames />
                </span>
                <span className={`bsp-xstatus ${XSTATUS[post.kind]}`}>{post.statusLabel}</span>
              </button>
            ))}
            {agenda.length === 0 ? (
              <span className="bsp-cal-aempty" data-testid="calendar-agenda-empty">
                {labels.agendaEmpty}
              </span>
            ) : null}
          </section>
        ) : (
          phone
        )
      ) : (
        <>
          <div className="bs-wide-only">
            {view === 'month' ? (
              <div
                className="bsp-card bsp-cal-grid"
                role="grid"
                aria-label={labels.calendarLabel}
                data-testid="calendar-month-grid"
              >
                <div role="row" style={{ display: 'contents' }}>
                  {weekdays.map((name) => (
                    <div key={name} role="columnheader" className="bsp-cal-wd">
                      {name}
                    </div>
                  ))}
                </div>
                {weeks.map((row) => (
                  <div key={row[0]?.key} role="row" style={{ display: 'contents' }}>
                    {row.map((day) => dayCell(day, 'month'))}
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="bsp-card bsp-cal-grid bsp-cal-week"
                role="grid"
                aria-label={labels.calendarLabel}
                data-testid="calendar-month-grid"
              >
                <div role="row" style={{ display: 'contents' }}>
                  {weekdays.map((name) => (
                    <div key={name} role="columnheader" className="bsp-cal-wd">
                      {name}
                    </div>
                  ))}
                </div>
                <div role="row" style={{ display: 'contents' }}>
                  {week.map((day) => dayCell(day, 'week'))}
                </div>
              </div>
            )}
          </div>
          <div className="bs-narrow-only">{phone}</div>
        </>
      )}

      {children}

      <div className="bsp-cal-legend" data-testid="calendar-legend">
        {labels.legend.map((item) => (
          <span key={item.kind} className="bsp-cal-legend-item">
            <span className="bsp-cal-legend-bar" data-k={item.kind} />
            {item.label}
          </span>
        ))}
        {labels.hint ? <span className="bsp-cal-hint">{labels.hint}</span> : null}
      </div>
      {dropStrip}
    </section>
  );
}
