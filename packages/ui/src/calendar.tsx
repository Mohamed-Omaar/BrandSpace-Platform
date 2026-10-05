'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  colorTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
  zIndexTokens,
} from './tokens';
import { Button, ButtonRow, IconButton } from './primitives';
import { ChevronEndIcon, ChevronStartIcon } from './icons';
import { CalendarPostChip, type PostCardLabels, type PostRecord } from './post-card';
import { StateMessage } from './feedback';
import { SegmentPill } from './segment-pill';
import { dropStateOf } from './calendar-drag';

/**
 * The social content calendar.
 *
 * A CREATIVE PLANNING SURFACE, NOT A BUSINESS CALENDAR. The month grid holds
 * content chips with thumbnails rather than text events, and the mobile view is
 * an AGENDA — a chronological list of days — rather than a month grid squeezed
 * into 390px, where a 7-column layout gives each day about 50 pixels and every
 * post becomes an unreadable sliver.
 *
 * PRESENTATIONAL, AND THAT IS THE WHOLE CONTRACT. It renders the days it is
 * handed and reports which post was clicked. It schedules nothing, publishes
 * nothing and talks to no platform — the caller owns all of that.
 *
 * Phase 5B-2 built the caller: `/[locale]/calendar` supplies the workspace's own
 * slots and owns scheduling, moving and cancelling. The design-system showcase
 * still supplies fixtures to the same component, which is what makes the two
 * agree about how a calendar looks.
 */

export type CalendarView = 'month' | 'week' | 'agenda';

export interface CalendarDay {
  readonly key: string;
  /** The day number as the caller's locale formats it. */
  readonly label: string;
  /** A fuller label for the agenda and for screen readers. */
  readonly longLabel: string;
  readonly inCurrentPeriod: boolean;
  readonly isToday: boolean;
  /**
   * F2 — before today. Marked on the cell (`data-past`) so a caller and a test
   * can tell; how a drop on it is answered is the caller's decision.
   */
  readonly isPast?: boolean;
  readonly posts: readonly PostRecord[];
  /**
   * G6 (prototype v94 Phase 2B-1, D-329) — the day's holidays and industry
   * observances, each a ★ chip; with an `href`, the chip opens the Studio for
   * this day.
   */
  readonly markers?: readonly CalendarDayMarker[];
}

export interface CalendarDayMarker {
  readonly label: string;
  readonly kind: 'holiday' | 'observance';
  readonly href?: string | undefined;
}

/**
 * THE ★ CHIP (G6, D-329) — a DESIGN-SYSTEM EXTENSION (UI-FIDELITY §6.3.32).
 *
 * Composed from what the calendar already draws: the "today" pill's accent
 * pair (`brandYellowTint` behind `brandYellowText`, 6.1:1) at the post chip's
 * `micro` size, so a day that means something reads apart from the posts on
 * it without a new colour or shape. A link when it leads somewhere — the
 * Studio for that day — and plain text otherwise.
 */
function DayMarkers({
  day,
  markers,
  testIdPrefix,
}: {
  readonly day: CalendarDay;
  readonly markers: readonly CalendarDayMarker[];
  /** The month grid and the agenda are both in the DOM; each names its own. */
  readonly testIdPrefix: string;
}) {
  return (
    <>
      {markers.map((marker, index) => {
        const style = {
          justifySelf: 'start',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          maxInlineSize: '100%',
          minBlockSize: '1.5rem',
          paddingInline: spacingTokens.xs,
          borderRadius: radiusTokens.full,
          background: colorTokens.brandYellowTint,
          color: colorTokens.brandYellowText,
          textDecoration: 'none',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          ...typographyTokens.micro,
          fontWeight: 700,
        } as const;
        const content = (
          <>
            <span aria-hidden="true">★</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{marker.label}</span>
          </>
        );
        const testId = `${testIdPrefix}-${day.key}-${index}`;
        return marker.href ? (
          <a
            key={`${marker.kind}-${index}`}
            href={marker.href}
            className="bs-pressable"
            data-testid={testId}
            data-kind={marker.kind}
            aria-label={`${marker.label} — ${day.longLabel}`}
            style={style}
          >
            {content}
          </a>
        ) : (
          <span
            key={`${marker.kind}-${index}`}
            data-testid={testId}
            data-kind={marker.kind}
            style={style}
          >
            {content}
          </span>
        );
      })}
    </>
  );
}

export interface CalendarLabels extends PostCardLabels {
  readonly calendarLabel: string;
  readonly monthView: string;
  readonly weekView: string;
  readonly agendaView: string;
  readonly today: string;
  readonly previous: string;
  readonly next: string;
  readonly createPost: string;
  readonly weekdayNames: readonly string[];
  readonly emptyDay: string;
  readonly emptyPeriodTitle: string;
  readonly emptyPeriodBody: string;
  readonly postsOnDay: (count: number) => string;
}

/**
 * The month grid.
 *
 * Hidden below `md` by `bs-wide-only`: see the agenda below for why.
 */
/** The days in rows of seven, so the grid can carry real `role="row"` groups. */
function weeksOf(days: readonly CalendarDay[]): readonly (readonly CalendarDay[])[] {
  const weeks: CalendarDay[][] = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(days.slice(index, index + 7));
  }
  return weeks;
}

function MonthGrid({
  days,
  labels,
  onOpenPost,
  dropTargets,
  postDragData,
  onCreateOnDay,
}: {
  readonly days: readonly CalendarDay[];
  readonly labels: CalendarLabels;
  readonly onOpenPost?: ((post: PostRecord) => void) | undefined;
  /**
   * §8.2 — each day says it can take a dragged post (`data-drop-day`), and
   * whether it will (`data-drop-state`: ok, past, or none outside the month).
   * `useCalendarDrag` reads them; the grid itself commits nothing.
   */
  readonly dropTargets?: boolean | undefined;
  /** B7 — the drag payload for a post that may move, or undefined when it may not. */
  readonly postDragData?: ((post: PostRecord) => string | undefined) | undefined;
  /** B7 — "new post" on an empty day that has not passed. */
  readonly onCreateOnDay?: ((dayKey: string) => void) | undefined;
}) {
  return (
    <div
      role="grid"
      aria-label={labels.calendarLabel}
      data-testid="calendar-month-grid"
      style={{
        /*
         * ONE CONTINUOUS SURFACE, NOT A GRID OF CARDS (§13).
         *
         * `.calendar { grid-template-columns: repeat(7, minmax(120px,1fr));
         *  gap: 1px; padding: 1px; background: rgba(17,17,20,.06);
         *  border-radius: 22px; overflow: auto; box-shadow: var(--soft-shadow) }`
         * with `.weekday, .day { background: rgba(255,255,255,.92) }`.
         *
         * The 1px gap and 1px padding over a faint dark ground ARE the
         * separators — the cells are opaque and the container shows through
         * between them. That is why the demo's month reads as one calendar
         * rather than as thirty-five rounded tiles floating apart, which is
         * what the product had and what §13 rules out by name.
         */
        display: 'grid',
        gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        gap: '1px',
        padding: '1px',
        background: 'rgba(17, 17, 20, 0.06)',
        borderRadius: '1.375rem',
        boxShadow: shadowTokens.card,
        overflow: 'hidden',
      }}
    >
      {/*
        ROWS ARE REQUIRED, even in a CSS grid. `role="grid"` may only contain
        `role="row"`, and a `columnheader`/`gridcell` may only sit inside one —
        axe reported both, as `aria-required-children` and
        `aria-required-parent`. `display: contents` gives the rows their
        semantics without adding a box, so the seven-column grid is unchanged.
      */}
      <div role="row" style={{ display: 'contents' }}>
        {labels.weekdayNames.map((name) => (
          <div
            key={name}
            role="columnheader"
            style={{
              // `.weekday { padding: 11px; font-size: 8px; font-weight: 850 }`.
              padding: '0.6875rem',
              background: 'rgba(255, 255, 255, 0.92)',
              fontSize: '0.5rem',
              lineHeight: '0.75rem',
              fontWeight: 850,
              textTransform: 'uppercase',
              letterSpacing: 'normal',
              color: colorTokens.textMuted,
              textAlign: 'start',
            }}
          >
            {name}
          </div>
        ))}
      </div>
      {weeksOf(days).map((week) => (
        <div key={week[0]?.key ?? 'week'} role="row" style={{ display: 'contents' }}>
          {week.map((day) => (
            <div
              key={day.key}
              role="gridcell"
              data-testid={`calendar-day-${day.key}`}
              data-past={day.isPast ? 'true' : undefined}
              {...(dropTargets
                ? { 'data-drop-day': day.key, 'data-drop-state': dropStateOf(day) }
                : {})}
              aria-label={`${day.longLabel} — ${labels.postsOnDay(day.posts.length)}`}
              style={{
                // `.day { min-height: 132px; padding: 10px;
                //  background: rgba(255,255,255,.92) }` — square-cornered,
                // because the container's 1px gutter draws the grid.
                minBlockSize: '8.25rem',
                padding: '0.625rem',
                borderRadius: 0,
                // Today is a lavender cell; a day outside the month is quieter.
                //
                // QUIETER BY SURFACE, NOT BY OPACITY. A container opacity blends
                // every descendant toward the page and silently drops their
                // contrast below AA — which is exactly how the feature cards'
                // badges failed. A softer background and a muted (but still
                // 4.6:1) number say the same thing honestly.
                background: day.isToday ? 'rgba(238, 230, 255, 0.92)' : 'rgba(255, 255, 255, 0.92)',
                display: 'grid',
                gridTemplateRows: 'auto 1fr',
                gap: spacingTokens['3xs'],
                alignContent: 'start',
              }}
            >
              <span
                style={{
                  /*
                   * `.day > strong { font-size: 10px }` and
                   * `.day.muted > strong { color: #bbb }`.
                   *
                   * DOCUMENTED DEVIATION: `#bbb` is 1.9:1 on the cell. An
                   * out-of-month day is quieted with `textMuted` (4.9:1)
                   * instead — the same device the F-28 lesson settled, and the
                   * only property changed is the colour, not the geometry.
                   */
                  fontSize: '0.625rem',
                  lineHeight: '0.875rem',
                  fontWeight: day.isToday ? 800 : 700,
                  color: day.isToday
                    ? colorTokens.brandPurplePressed
                    : day.inCurrentPeriod
                      ? colorTokens.textPrimary
                      : colorTokens.textMuted,
                }}
              >
                {day.label}
              </span>
              <div style={{ display: 'grid', gap: spacingTokens['3xs'], alignContent: 'start' }}>
                {day.markers && day.markers.length > 0 ? (
                  <DayMarkers day={day} markers={day.markers} testIdPrefix="calendar-marker" />
                ) : null}
                {day.posts.map((post) => (
                  <CalendarPostChip
                    key={post.id}
                    post={post}
                    labels={labels}
                    onOpen={onOpenPost ? () => onOpenPost(post) : undefined}
                    dragData={postDragData?.(post)}
                    dragDay={day.key}
                  />
                ))}
                {onCreateOnDay && !day.isPast && day.posts.length === 0 ? (
                  /*
                   * B7 — a new post on THIS day. Quiet until needed: a neutral
                   * text-size control composed from the ghost button style, so
                   * an empty month does not turn into a wall of buttons.
                   */
                  <button
                    type="button"
                    className="bs-pressable"
                    data-testid={`calendar-new-${day.key}`}
                    aria-label={`${labels.createPost} — ${day.longLabel}`}
                    onClick={() => onCreateOnDay(day.key)}
                    style={{
                      justifySelf: 'start',
                      minBlockSize: '1.5rem',
                      paddingInline: spacingTokens.xs,
                      border: '1px solid transparent',
                      borderRadius: radiusTokens.md,
                      background: 'transparent',
                      color: colorTokens.textSecondary,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      ...typographyTokens.micro,
                      fontWeight: 700,
                    }}
                  >
                    + {labels.createPost}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The agenda.
 *
 * The mobile experience AND a first-class desktop view. A chronological list of
 * days with full content chips reads better on a phone than any grid, and it is
 * what a person actually wants when the question is "what is going out next".
 */
/**
 * Exported for the prototype calendar (D-468 batch 2): below 768px the product
 * keeps this phone agenda in place of the ported grid (D-468 (b)).
 */
export function CalendarAgenda(props: Parameters<typeof Agenda>[0]) {
  return <Agenda {...props} />;
}

function Agenda({
  days,
  labels,
  onOpenPost,
  postDragData,
  emptyAction,
}: {
  readonly days: readonly CalendarDay[];
  readonly labels: CalendarLabels;
  readonly onOpenPost?: ((post: PostRecord) => void) | undefined;
  /** §8.2 — on the list, a long-press lifts a post onto the drop strip. */
  readonly postDragData?: ((post: PostRecord) => string | undefined) | undefined;
  readonly emptyAction?: ReactNode;
}) {
  // A day with a ★ holiday or observance is listed too, so the phone's agenda
  // says what the month grid says (G6, D-329).
  const withPosts = days.filter(
    (day) => day.posts.length > 0 || (day.markers !== undefined && day.markers.length > 0),
  );
  if (withPosts.length === 0) {
    return (
      <StateMessage
        title={labels.emptyPeriodTitle}
        description={labels.emptyPeriodBody}
        action={emptyAction}
        testId="calendar-agenda-empty"
      />
    );
  }
  return (
    <ol
      data-testid="calendar-agenda"
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: spacingTokens.lg }}
    >
      {withPosts.map((day) => (
        <li key={day.key} data-testid={`agenda-day-${day.key}`}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: spacingTokens.sm,
              marginBlockEnd: spacingTokens.sm,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minInlineSize: '2.5rem',
                blockSize: '2.5rem',
                borderRadius: radiusTokens.md,
                background: day.isToday
                  ? colorTokens.brandPurple
                  : colorTokens.surfaceLavenderStrong,
                color: day.isToday ? colorTokens.brandPurpleInk : colorTokens.brandPurplePressed,
                ...typographyTokens.label,
                fontWeight: 700,
              }}
            >
              {day.label}
            </span>
            <span style={{ ...typographyTokens.label, color: colorTokens.textSecondary }}>
              {day.longLabel}
            </span>
            {day.isToday ? (
              <span
                style={{
                  marginInlineStart: 'auto',
                  paddingInline: spacingTokens.sm,
                  borderRadius: radiusTokens.full,
                  background: colorTokens.brandYellowTint,
                  color: colorTokens.brandYellowText,
                  ...typographyTokens.caption,
                  fontWeight: 700,
                }}
              >
                {labels.today}
              </span>
            ) : null}
          </div>
          <div style={{ display: 'grid', gap: spacingTokens.xs }}>
            {day.markers && day.markers.length > 0 ? (
              <DayMarkers day={day} markers={day.markers} testIdPrefix="agenda-marker" />
            ) : null}
            {day.posts.map((post) => (
              <CalendarPostChip
                key={post.id}
                post={post}
                labels={labels}
                onOpen={onOpenPost ? () => onOpenPost(post) : undefined}
                dragData={postDragData?.(post)}
                dragDay={day.key}
              />
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ContentCalendar({
  periodLabel,
  days,
  labels,
  filters,
  onOpenPost,
  createAction,
  testId,
  onPrevious,
  onNext,
  onToday,
  busy,
  weekIndex = 0,
  dropTargets,
  dropStrip,
  postDragData,
  onCreateOnDay,
  emptyAction,
}: {
  readonly periodLabel: string;
  readonly days: readonly CalendarDay[];
  readonly labels: CalendarLabels;
  /** The filter row. Supplied by the caller so it can hold real options. */
  readonly filters?: ReactNode;
  readonly onOpenPost?: ((post: PostRecord) => void) | undefined;
  readonly createAction?: ReactNode;
  readonly testId?: string | undefined;
  /**
   * Period navigation.
   *
   * OPTIONAL, because the design-system showcase renders a fixed month and has
   * nowhere to navigate to. When a caller supplies them the three controls
   * become live; when it does not they are DISABLED rather than inert, so a
   * control that cannot do anything says so instead of silently ignoring the
   * click — which is the difference between a prototype and a broken product.
   */
  readonly onPrevious?: (() => void) | undefined;
  readonly onNext?: (() => void) | undefined;
  readonly onToday?: (() => void) | undefined;
  /** Marks the grid busy while a navigation is in flight. */
  readonly busy?: boolean | undefined;
  /**
   * PHASE 6 FINAL (D-290) — which row of the month the Week view shows (the
   * week containing today, when the caller knows it). The first row otherwise.
   */
  readonly weekIndex?: number | undefined;
  /**
   * §8.2 — the month and week days are drop targets. The caller's
   * `useCalendarDrag` does the dragging and commits the drop; drag is never
   * the only way to schedule or move.
   */
  readonly dropTargets?: boolean | undefined;
  /**
   * §8.2 — the phone's drop strip (`CalendarDropStrip`), shown wherever the
   * calendar is a list: always below `md`, and in the Agenda view.
   */
  readonly dropStrip?: ReactNode;
  /** B7 — the drag payload for a post that may move to another day. */
  readonly postDragData?: ((post: PostRecord) => string | undefined) | undefined;
  /** B7 — "new post" on an empty day that has not passed. */
  readonly onCreateOnDay?: ((dayKey: string) => void) | undefined;
  /** D-299 (§43) — what an empty agenda offers: the caller's next step. */
  readonly emptyAction?: ReactNode;
}) {
  const [view, setView] = useState<CalendarView>('month');
  /*
   * D-306 — AGENDA FIRST ON A PHONE. Below the wide breakpoint the grid is
   * never drawn, so the switcher now SAYS Agenda there instead of claiming a
   * month view the reader cannot see. Month and Week stay one tap away.
   */
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
      setView('agenda');
    }
  }, []);

  const viewButton = (value: CalendarView, label: string) => (
    <button
      key={value}
      type="button"
      className="bs-pressable"
      data-testid={`calendar-view-${value}`}
      aria-pressed={view === value}
      onClick={() => setView(value)}
      style={{
        minBlockSize: '2.25rem',
        paddingInline: spacingTokens.md,
        borderRadius: radiusTokens.md,
        border: '1px solid transparent',
        cursor: 'pointer',
        fontFamily: 'inherit',
        ...typographyTokens.caption,
        fontWeight: 600,
        background: view === value ? colorTokens.surface : 'transparent',
        color: view === value ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
        boxShadow: view === value ? '0 1px 2px rgba(23,21,40,0.06)' : 'none',
      }}
    >
      {label}
    </button>
  );

  return (
    <section
      data-testid={testId ?? 'content-calendar'}
      aria-busy={busy ?? undefined}
      style={{ display: 'grid', gap: spacingTokens.lg }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: spacingTokens.sm,
        }}
      >
        <ButtonRow gap={spacingTokens.xs}>
          <IconButton
            label={labels.previous}
            variant="neutral"
            size="sm"
            icon={<ChevronStartIcon size={18} />}
            data-testid="calendar-previous"
            disabled={!onPrevious}
            {...(onPrevious ? { onClick: onPrevious } : {})}
          />
          <IconButton
            label={labels.next}
            variant="neutral"
            size="sm"
            icon={<ChevronEndIcon size={18} />}
            data-testid="calendar-next"
            disabled={!onNext}
            {...(onNext ? { onClick: onNext } : {})}
          />
          <Button
            variant="neutral"
            size="sm"
            data-testid="calendar-today"
            disabled={!onToday}
            {...(onToday ? { onClick: onToday } : {})}
          >
            {labels.today}
          </Button>
        </ButtonRow>

        <h2
          data-testid="calendar-period"
          style={{
            ...typographyTokens.h2,
            color: colorTokens.textPrimary,
            marginInline: spacingTokens.sm,
          }}
        >
          {periodLabel}
        </h2>

        <div
          role="group"
          aria-label={labels.calendarLabel}
          style={{
            marginInlineStart: 'auto',
            display: 'inline-flex',
            gap: spacingTokens['3xs'],
            padding: spacingTokens['3xs'],
            borderRadius: radiusTokens.md,
            background: colorTokens.surfaceMuted,
          }}
        >
          {/* MO4: the chosen view's pill slides between views. */}
          <SegmentPill selector='[aria-pressed="true"]' />
          {viewButton('month', labels.monthView)}
          {viewButton('week', labels.weekView)}
          {viewButton('agenda', labels.agendaView)}
        </div>

        {createAction}
      </div>

      {/*
        THE FILTER ROW WRAPS; it does not stack. The calendar renders in a grid,
        where a block child takes the full column — so the caller's filters were
        each landing on their own line. This gives them a flex row of their own.
      */}
      {filters ? (
        <div
          data-testid="calendar-filters"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: spacingTokens.xs,
          }}
        >
          {filters}
        </div>
      ) : null}

      {/*
        The month and week grids exist on a wide screen only. On a phone the
        agenda is shown instead — not the same grid made small, which is what
        the brief explicitly rules out and what makes a 7-column calendar
        useless at 390px.
      */}
      {view === 'agenda' ? (
        <Agenda
          days={days}
          labels={labels}
          onOpenPost={onOpenPost}
          postDragData={postDragData}
          emptyAction={emptyAction}
        />
      ) : (
        <>
          <div className="bs-wide-only">
            <MonthGrid
              days={view === 'week' ? days.slice(weekIndex * 7, weekIndex * 7 + 7) : days}
              labels={labels}
              onOpenPost={onOpenPost}
              dropTargets={dropTargets}
              postDragData={postDragData}
              onCreateOnDay={onCreateOnDay}
            />
          </div>
          <div className="bs-narrow-only">
            <Agenda
              days={days}
              labels={labels}
              onOpenPost={onOpenPost}
              postDragData={postDragData}
              emptyAction={emptyAction}
            />
          </div>
        </>
      )}
      {dropStrip ? (
        <div className={view === 'agenda' ? undefined : 'bs-narrow-only'}>{dropStrip}</div>
      ) : null}
    </section>
  );
}

/** One day on the phone's drop strip, already in the reader's language. */
export interface DropStripDay {
  readonly key: string;
  /** The short weekday ("Wed"). */
  readonly weekday: string;
  /** The day number ("21"). */
  readonly label: string;
  /** For screen readers: the whole date. */
  readonly longLabel: string;
}

/**
 * §8.2 — THE PHONE'S DROP STRIP.
 *
 * "The calendar is a list, so a long-press lifts the post and a glass strip
 * with the next 14 days slides up from the bottom; dropping on a day moves it."
 * Two rows of seven, so all fourteen fit a 390 px screen without a scroll the
 * drag would have to fight. Every day is a drop target like a month cell
 * (`data-drop-day`); the strip commits nothing itself.
 *
 * DESIGN-SYSTEM EXTENSION (UI-FIDELITY §6): the glass is the dropdown panel's
 * (`--bs-surface-glass`, 24 px blur), the days are the agenda's day badges.
 */
export function CalendarDropStrip({
  days,
  title,
}: {
  readonly days: readonly DropStripDay[];
  readonly title: string;
}) {
  return (
    <div
      role="region"
      aria-label={title}
      data-testid="calendar-drop-strip"
      className="bs-drag-strip"
      style={{
        position: 'fixed',
        insetInline: spacingTokens.md,
        insetBlockEnd: spacingTokens.md,
        zIndex: zIndexTokens.overlay,
        display: 'grid',
        gap: spacingTokens.xs,
        padding: spacingTokens.sm,
        borderRadius: '1.375rem',
        boxShadow: shadowTokens.card,
      }}
    >
      <span
        style={{ ...typographyTokens.caption, fontWeight: 700, color: colorTokens.textSecondary }}
      >
        {title}
      </span>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          gap: '0.25rem',
        }}
      >
        {days.map((day) => (
          <div
            key={day.key}
            data-testid={`calendar-strip-${day.key}`}
            data-drop-day={day.key}
            data-drop-state="ok"
            aria-label={day.longLabel}
            style={{
              display: 'grid',
              justifyItems: 'center',
              gap: '1px',
              paddingBlock: spacingTokens.xs,
              borderRadius: radiusTokens.md,
              background: colorTokens.surfaceLavenderStrong,
              color: colorTokens.brandPurplePressed,
            }}
          >
            <span style={{ ...typographyTokens.caption, fontWeight: 600 }}>{day.weekday}</span>
            <span style={{ ...typographyTokens.label, fontWeight: 700 }}>{day.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
