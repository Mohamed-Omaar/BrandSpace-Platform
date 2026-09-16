import type { CSSProperties, ReactNode } from 'react';
import { colorTokens, radiusTokens, spacingTokens, typographyTokens } from './tokens';
import { Cell, DataTable, Row } from './data';
import { visuallyHiddenStyle } from './a11y';

/**
 * CHART PRIMITIVES — Phase 7, and an APPROVED DESIGN-SYSTEM EXTENSION under
 * CLAUDE.md §4.2 (recorded in docs/UI-FIDELITY-CONTRACT.md §6).
 *
 * THERE IS NO APPROVED DEMO FOR AN ANALYTICS CHART. §4.2 is explicit that this is
 * not a licence to invent and not a reason to stop: the screen is built from the
 * platform's own visual language — its tokens, its spacing, its card surfaces,
 * its RTL behaviour — and recorded as an extension rather than as a port.
 *
 * FOUR DECISIONS, AND EACH ONE HAS A REASON THAT SURVIVED A CHECK:
 *
 *  1. ONE SERIES PER CHART, ONE HUE. The design system has no categorical ramp,
 *     and §4.2 rule 5 forbids introducing a new colour family. It does not need
 *     one: a comparison ACROSS categories is a bar chart whose identity is
 *     carried by its axis labels, and a trend OVER time is a single line. Neither
 *     needs a second hue, so no palette was invented to supply one.
 *
 *  2. THE YELLOW ACCENT IS NOT A MARK COLOUR. `brandYellow` is 1.31:1 against
 *     white — far below the 3:1 a chart mark needs — which is the same fact
 *     CLAUDE.md §4 states as "yellow is never used as text without its darkened
 *     token". Marks are `brandPurple`, measured at 5.60:1.
 *
 *  3. COLOUR IS NEVER THE ONLY SIGNAL (WCAG 1.4.1). Every chart here ships with a
 *     real `<table>` carrying the same numbers, reachable by keyboard and read by
 *     a screen reader; every mark carries an SVG `<title>`; and identity comes
 *     from labels rather than from hue. A greyscale print of these charts loses
 *     nothing.
 *
 *  4. A GAP IS A GAP, NOT A ZERO. A period with no observation breaks the line
 *     and renders no marker, and its table row says so in words. Drawing a zero
 *     would be claiming a measurement of none, which is the single dishonesty
 *     this whole phase is built to avoid.
 *
 * RTL. Time flows in the READING DIRECTION: left to right in English, right to
 * left in Arabic. The flip is a coordinate transform on the plotted geometry, not
 * a CSS mirror of the whole element — mirroring would reverse the digits in every
 * axis label too.
 */

/** One plotted point. `value` of `null` is MISSING and renders as a gap. */
export interface ChartPoint {
  /** Already formatted for the reader's locale by the caller. */
  readonly label: string;
  readonly value: number | null;
  /** What the reader is told when the value is missing. Never "0". */
  readonly absentLabel?: string | undefined;
  /** The formatted value, so the table and the tooltip agree with the tile. */
  readonly formatted?: string | undefined;
}

export interface ChartLabels {
  /** The chart's own name. A single series needs no legend; the title names it. */
  readonly title: string;
  /** One sentence describing the shape, for a screen reader. */
  readonly description: string;
  /** The accessible table's caption, and the column headers. */
  readonly tableCaption: string;
  readonly periodColumn: string;
  readonly valueColumn: string;
  /** Rendered in a cell where there is no measurement. */
  readonly noValue: string;
}

const PLOT_HEIGHT = 180;
const PLOT_WIDTH = 640;
const PADDING = { top: 16, right: 16, bottom: 28, left: 16 };

/**
 * The accessible table every chart ships with.
 *
 * A REAL TABLE, NOT AN `aria-label` ON THE SVG. A sentence describing a shape is
 * not the data; somebody using a screen reader is entitled to the numbers, in the
 * same order, with the same formatting the sighted reader sees.
 */
export function ChartDataTable({
  labels,
  points,
}: {
  readonly labels: ChartLabels;
  readonly points: readonly ChartPoint[];
}) {
  return (
    <DataTable
      caption={labels.tableCaption}
      headers={[labels.periodColumn, labels.valueColumn]}
      minWidth="16rem"
      testId="chart-data-table"
    >
      {points.map((point) => (
        <Row key={point.label}>
          <Cell>{point.label}</Cell>
          <Cell>
            {point.value === null
              ? (point.absentLabel ?? labels.noValue)
              : (point.formatted ?? String(point.value))}
          </Cell>
        </Row>
      ))}
    </DataTable>
  );
}

/**
 * A single-series trend over time.
 *
 * DRAWN AS A LINE WITH MARKERS at every measured point. The markers are 8px
 * across, which is the floor a pointer can reasonably hit and the size at which a
 * lone point in a sea of gaps is still visible — a chart whose only measured day
 * rendered as a one-pixel dot would read as empty.
 */
export function TrendChart({
  labels,
  points,
  direction = 'ltr',
  testId,
}: {
  readonly labels: ChartLabels;
  readonly points: readonly ChartPoint[];
  readonly direction?: 'ltr' | 'rtl';
  readonly testId?: string | undefined;
}) {
  const titleId = `${testId ?? 'trend'}-title`;
  const descriptionId = `${testId ?? 'trend'}-desc`;

  const measured = points.filter((point) => point.value !== null);
  const values = measured.map((point) => point.value as number);
  const max = values.length > 0 ? Math.max(...values) : 0;
  const min = values.length > 0 ? Math.min(...values, 0) : 0;
  const span = max - min || 1;

  const innerWidth = PLOT_WIDTH - PADDING.left - PADDING.right;
  const innerHeight = PLOT_HEIGHT - PADDING.top - PADDING.bottom;
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;

  const xFor = (index: number): number => {
    const offset = PADDING.left + index * step;
    // THE READING DIRECTION, as a coordinate transform. Mirroring the element
    // with a CSS transform would reverse the digits inside every axis label.
    return direction === 'rtl' ? PLOT_WIDTH - offset : offset;
  };
  const yFor = (value: number): number =>
    PADDING.top + innerHeight - ((value - min) / span) * innerHeight;

  /*
   * THE PATH BREAKS AT EVERY GAP. Built as a list of segments rather than one
   * `d` string with `M` inserted blindly: a single missing day between two
   * measured ones must leave a visible hole, not a straight line drawn through a
   * day nobody measured.
   */
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    const command = current.length === 0 ? 'M' : 'L';
    current.push(`${command}${xFor(index).toFixed(2)},${yFor(point.value).toFixed(2)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));

  const firstMeasured = points.findIndex((point) => point.value !== null);
  const lastMeasured = points.length - 1 - [...points].reverse().findIndex((p) => p.value !== null);

  return (
    <figure style={{ margin: 0 }} data-testid={testId ?? 'trend-chart'}>
      <figcaption
        id={titleId}
        style={{ ...typographyTokens.label, color: colorTokens.textSecondary }}
      >
        {labels.title}
      </figcaption>
      <svg
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
        viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
        preserveAspectRatio="none"
        style={{ inlineSize: '100%', blockSize: '11.25rem', display: 'block' }}
      >
        <desc id={descriptionId}>{labels.description}</desc>

        {/* RECESSIVE GRID. Three lines, hairline weight, behind everything. */}
        {[0, 0.5, 1].map((fraction) => (
          <line
            key={fraction}
            x1={PADDING.left}
            x2={PLOT_WIDTH - PADDING.right}
            y1={PADDING.top + innerHeight * fraction}
            y2={PADDING.top + innerHeight * fraction}
            stroke={colorTokens.hairline}
            strokeWidth={1}
          />
        ))}

        {segments.map((segment) => (
          <path
            key={segment.slice(0, 32)}
            d={segment}
            fill="none"
            stroke={colorTokens.brandPurple}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {points.map((point, index) =>
          point.value === null ? null : (
            <circle
              key={point.label}
              cx={xFor(index)}
              cy={yFor(point.value)}
              r={4}
              fill={colorTokens.brandPurple}
              /*
               * A 2px SURFACE RING, so two points that land close together stay
               * two points rather than a smear.
               */
              stroke={colorTokens.surface}
              strokeWidth={2}
            >
              {/*
               * THE HOVER LAYER, with no JavaScript. A native SVG `<title>` is a
               * tooltip to a pointer and a name to a screen reader, which is the
               * whole of what a tooltip on a static chart owes either of them —
               * and it works in a server component, where a React event handler
               * would not.
               */}
              <title>{`${point.label}: ${point.formatted ?? point.value}`}</title>
            </circle>
          ),
        )}

        {/*
         * SELECTIVE DIRECT LABELS — the first and last measured points, and only
         * those. A number on every point is the anti-pattern; two numbers tell a
         * reader where the series starts and where it ends, which is what a trend
         * is.
         */}
        {[firstMeasured, lastMeasured]
          .filter((index, position, all) => index >= 0 && all.indexOf(index) === position)
          .map((index) => {
            const point = points[index];
            if (!point || point.value === null) return null;
            const x = xFor(index);
            return (
              <text
                key={`label-${point.label}`}
                x={x}
                y={Math.max(PADDING.top - 4, yFor(point.value) - 10)}
                textAnchor={x > PLOT_WIDTH / 2 ? 'end' : 'start'}
                /* TEXT WEARS A TEXT TOKEN, never the series colour. */
                fill={colorTokens.textSecondary}
                fontSize={12}
              >
                {point.formatted ?? point.value}
              </text>
            );
          })}
      </svg>

      {/* The numbers, for everyone who cannot or does not want to read a shape. */}
      <ChartDataTable labels={labels} points={points} />
    </figure>
  );
}

/**
 * A single-measure comparison across categories.
 *
 * HORIZONTAL BARS, ONE HUE, AND THE CATEGORY NAME ON THE AXIS. That is what makes
 * a categorical palette unnecessary: identity is carried by a label a reader can
 * read, in any colour vision, in greyscale and in print.
 */
export function ComparisonChart({
  labels,
  points,
  direction = 'ltr',
  testId,
}: {
  readonly labels: ChartLabels;
  readonly points: readonly ChartPoint[];
  readonly direction?: 'ltr' | 'rtl';
  readonly testId?: string | undefined;
}) {
  const measured = points.filter((point) => point.value !== null);
  const max = measured.length > 0 ? Math.max(...measured.map((p) => p.value as number), 1) : 1;

  return (
    <figure style={{ margin: 0 }} data-testid={testId ?? 'comparison-chart'}>
      <figcaption style={{ ...typographyTokens.label, color: colorTokens.textSecondary }}>
        {labels.title}
      </figcaption>
      <span style={visuallyHiddenStyle()}>{labels.description}</span>

      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gap: spacingTokens.sm,
          marginBlockStart: spacingTokens.sm,
        }}
      >
        {points.map((point) => {
          const fraction = point.value === null ? 0 : Math.max(0.02, point.value / max);
          return (
            <li key={point.label} style={{ display: 'grid', gap: '0.125rem' }}>
              <span
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: spacingTokens.sm,
                  ...typographyTokens.caption,
                  color: colorTokens.textSecondary,
                }}
              >
                <span>{point.label}</span>
                <span style={{ color: colorTokens.textPrimary }}>
                  {point.value === null
                    ? (point.absentLabel ?? labels.noValue)
                    : (point.formatted ?? point.value)}
                </span>
              </span>
              <span
                aria-hidden="true"
                style={{
                  display: 'block',
                  blockSize: '0.5rem',
                  background: colorTokens.surfaceSunken,
                  borderRadius: radiusTokens.full,
                  overflow: 'hidden',
                  // The track fills from the reading edge, so a bar grows the way
                  // the reader's eye travels.
                  direction,
                }}
              >
                <span
                  style={{
                    display: 'block',
                    blockSize: '100%',
                    inlineSize: `${(fraction * 100).toFixed(1)}%`,
                    /*
                     * A MISSING VALUE DRAWS NO BAR AT ALL — not a bar of width
                     * zero, which reads as "measured, and it was none". The row
                     * still appears, with its reason in words beside it.
                     */
                    background: point.value === null ? 'transparent' : colorTokens.brandPurple,
                    borderRadius: radiusTokens.full,
                  }}
                />
              </span>
            </li>
          );
        })}
      </ul>

      {/*
       * THE TABLE IS STILL HERE even though the list above already shows numbers:
       * the list is a visual arrangement and the table is a structure a screen
       * reader can navigate by row and column.
       */}
      <ChartDataTable labels={labels} points={points} />
    </figure>
  );
}

/**
 * A period-over-period change, rendered without relying on colour.
 *
 * AN ARROW AND A SIGN, not a green number and a red one. 1.4.1 forbids colour as
 * the only carrier, and a change indicator is the single most common place a
 * product breaks it.
 *
 * NULL IS "NO COMPARISON", NOT "NO CHANGE". A change from nothing is undefined,
 * and every product that renders it as `+100%` is inventing a comparison.
 */
export function ChangeIndicator({
  changeMilli,
  label,
  noComparisonLabel,
}: {
  readonly changeMilli: number | null;
  /** The formatted change, e.g. "+12.4%". Supplied by the caller's formatter. */
  readonly label: string | null;
  readonly noComparisonLabel: string;
}) {
  if (changeMilli === null || label === null) {
    return (
      <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
        {noComparisonLabel}
      </span>
    );
  }
  const up = changeMilli > 0;
  const flat = changeMilli === 0;
  const style: CSSProperties = {
    ...typographyTokens.caption,
    color: flat ? colorTokens.textMuted : up ? colorTokens.success : colorTokens.danger,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
  };
  return (
    <span style={style} data-testid="change-indicator">
      {/* THE GLYPH IS THE SIGNAL; the colour reinforces it and never replaces it. */}
      <span aria-hidden="true">{flat ? '→' : up ? '↑' : '↓'}</span>
      {label}
    </span>
  );
}

/**
 * A panel that says, in words, why there is no chart.
 *
 * THE HONEST EMPTY STATE IS A FINISHED SCREEN. Every reason this product can have
 * for an absent number is a different sentence — the platform does not publish
 * it, nothing has been published, the reading has not arrived, the account needs
 * reconnecting — and a plausible-looking zero standing for all four is the thing
 * Phase 7 exists not to do.
 */
export function ChartUnavailable({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
}) {
  return (
    <div
      data-testid="chart-unavailable"
      style={{
        display: 'grid',
        gap: spacingTokens.xs,
        padding: spacingTokens.lg,
        background: colorTokens.surfaceSoft,
        borderRadius: radiusTokens.lg,
        textAlign: 'center',
      }}
    >
      <span style={{ ...typographyTokens.label, color: colorTokens.textPrimary }}>{title}</span>
      <span style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>{body}</span>
      {action}
    </div>
  );
}
