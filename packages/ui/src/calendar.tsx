'use client';

import { useState, type ReactNode } from 'react';
import { colorTokens, radiusTokens, spacingTokens, typographyTokens } from './tokens';
import { Button, ButtonRow, IconButton } from './primitives';
import { ChevronEndIcon, ChevronStartIcon } from './icons';
import { CalendarPostChip, type PostCardLabels, type PostRecord } from './post-card';
import { StateMessage } from './feedback';

/**
 * The social content calendar.
 *
 * A CREATIVE PLANNING SURFACE, NOT A BUSINESS CALENDAR. The month grid holds
 * content chips with thumbnails rather than text events, and the mobile view is
 * an AGENDA — a chronological list of days — rather than a month grid squeezed
 * into 390px, where a 7-column layout gives each day about 50 pixels and every
 * post becomes an unreadable sliver.
 *
 * PROTOTYPE BOUNDARY. This renders supplied fixtures and reports selection. It
 * schedules nothing, publishes nothing and talks to no platform; the Phase 3
 * calendar will reuse this composition with real data behind it.
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
  readonly posts: readonly PostRecord[];
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
}: {
  readonly days: readonly CalendarDay[];
  readonly labels: CalendarLabels;
  readonly onOpenPost?: ((post: PostRecord) => void) | undefined;
}) {
  return (
    <div
      role="grid"
      aria-label={labels.calendarLabel}
      data-testid="calendar-month-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        gap: spacingTokens['3xs'],
        background: colorTokens.surfaceSoft,
        borderRadius: radiusTokens.xl,
        padding: spacingTokens.sm,
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
              padding: spacingTokens.xs,
              ...typographyTokens.caption,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: colorTokens.textSecondary,
              textAlign: 'center',
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
              aria-label={`${day.longLabel} — ${labels.postsOnDay(day.posts.length)}`}
              style={{
                minBlockSize: '7.5rem',
                padding: spacingTokens.xs,
                borderRadius: radiusTokens.md,
                // Today is a lavender cell; a day outside the month is quieter.
                //
                // QUIETER BY SURFACE, NOT BY OPACITY. A container opacity blends
                // every descendant toward the page and silently drops their
                // contrast below AA — which is exactly how the feature cards'
                // badges failed. A softer background and a muted (but still
                // 4.6:1) number say the same thing honestly.
                background: day.isToday
                  ? colorTokens.surfaceLavenderStrong
                  : day.inCurrentPeriod
                    ? colorTokens.surface
                    : colorTokens.surfaceMuted,
                display: 'grid',
                gridTemplateRows: 'auto 1fr',
                gap: spacingTokens['3xs'],
                alignContent: 'start',
              }}
            >
              <span
                style={{
                  ...typographyTokens.caption,
                  fontWeight: day.isToday ? 700 : 600,
                  color: day.isToday
                    ? colorTokens.brandPurplePressed
                    : day.inCurrentPeriod
                      ? colorTokens.textSecondary
                      : colorTokens.textMuted,
                }}
              >
                {day.label}
              </span>
              <div style={{ display: 'grid', gap: spacingTokens['3xs'], alignContent: 'start' }}>
                {day.posts.map((post) => (
                  <CalendarPostChip
                    key={post.id}
                    post={post}
                    labels={labels}
                    onOpen={onOpenPost ? () => onOpenPost(post) : undefined}
                  />
                ))}
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
function Agenda({
  days,
  labels,
  onOpenPost,
}: {
  readonly days: readonly CalendarDay[];
  readonly labels: CalendarLabels;
  readonly onOpenPost?: ((post: PostRecord) => void) | undefined;
}) {
  const withPosts = days.filter((day) => day.posts.length > 0);
  if (withPosts.length === 0) {
    return <StateMessage title={labels.emptyPeriodTitle} description={labels.emptyPeriodBody} />;
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
            {day.posts.map((post) => (
              <CalendarPostChip
                key={post.id}
                post={post}
                labels={labels}
                onOpen={onOpenPost ? () => onOpenPost(post) : undefined}
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
}: {
  readonly periodLabel: string;
  readonly days: readonly CalendarDay[];
  readonly labels: CalendarLabels;
  /** The filter row. Supplied by the caller so it can hold real options. */
  readonly filters?: ReactNode;
  readonly onOpenPost?: ((post: PostRecord) => void) | undefined;
  readonly createAction?: ReactNode;
  readonly testId?: string | undefined;
}) {
  const [view, setView] = useState<CalendarView>('month');

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
          />
          <IconButton
            label={labels.next}
            variant="neutral"
            size="sm"
            icon={<ChevronEndIcon size={18} />}
            data-testid="calendar-next"
          />
          <Button variant="neutral" size="sm" data-testid="calendar-today">
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
        <Agenda days={days} labels={labels} onOpenPost={onOpenPost} />
      ) : (
        <>
          <div className="bs-wide-only">
            <MonthGrid
              days={view === 'week' ? days.slice(0, 7) : days}
              labels={labels}
              onOpenPost={onOpenPost}
            />
          </div>
          <div className="bs-narrow-only">
            <Agenda days={days} labels={labels} onOpenPost={onOpenPost} />
          </div>
        </>
      )}
    </section>
  );
}
