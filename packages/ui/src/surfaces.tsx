import type { CSSProperties, ReactNode } from 'react';
import {
  colorTokens,
  layoutTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
} from './tokens';
import { IconTile } from './primitives';

/**
 * Surfaces and structure: cards, metric cards, page and section headers, grids.
 *
 * THE CARD LOST ITS BORDER (D-54). It used to be a white rectangle with a grey
 * stroke on a white page, which meant the stroke was the only thing telling you
 * where a section began — and twelve of those on a screen is the outlined admin
 * template the owner rejected.
 *
 * A card is now identified by a soft fill, a large radius and a shadow so wide
 * and faint it is felt rather than seen. `tone` chooses which supporting
 * surface it sits on; nothing here draws a box around anything.
 */

export type SurfaceTone = 'plain' | 'soft' | 'warm' | 'lavender';

const TONE_BACKGROUND: Record<SurfaceTone, string> = {
  // `.surface-card { background: rgba(255,255,255,.82) }` — translucent over
  // the shell, so the ambient light reaches the card too.
  plain: colorTokens.surfaceCardAlpha,
  soft: colorTokens.surfaceSoft,
  warm: colorTokens.surfaceWarm,
  lavender: colorTokens.surfaceLavender,
};

export function cardStyle(
  options: { padded?: boolean; tone?: SurfaceTone; elevated?: boolean } = {},
): CSSProperties {
  const { padded = true, tone = 'plain', elevated = true } = options;
  return {
    background: TONE_BACKGROUND[tone],
    // `.surface-card { border-radius: 18px }`.
    borderRadius: radiusTokens['2xl'],
    /*
     * NO RESTING BORDER AT ALL (D-59, tightening D-54).
     *
     * The hairline that used to sit here was the last remnant of the outlined
     * console: invisible on its own, but visible as a grid of faint rectangles
     * once twelve of them share a screen — which is exactly the effect the
     * owner rejected. The wide, faint shadow does the whole job now.
     *
     * The transparent border is kept rather than removed so that
     * `prefers-contrast: more` and `forced-colors: active` can swap a real 3:1
     * edge back in from `tokens.css` without changing the box model.
     */
    border: '1px solid transparent',
    boxShadow: elevated ? shadowTokens.card : 'none',
    // `.surface-card { padding: 22px }`.
    padding: padded ? layoutTokens.surfacePad : 0,
    /*
     * A GRID OR FLEX ITEM DEFAULTS TO `min-width: auto`, which means it refuses
     * to shrink below its content. A card holding a table with a 40rem minimum
     * therefore pushed the whole page sideways at 768px instead of letting the
     * table scroll inside its own box — which is exactly what that box is for.
     * Zero here restores the intended behaviour everywhere a card is laid out.
     */
    minInlineSize: 0,
  };
}

export function Card({
  title,
  description,
  actions,
  footer,
  icon,
  iconTone = 'brand',
  tone = 'plain',
  padded = true,
  elevated = true,
  children,
  testId,
}: {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  /** A glyph for the card's header, rendered in a soft tile. */
  readonly icon?: ReactNode;
  readonly iconTone?: 'brand' | 'accent' | 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  readonly tone?: SurfaceTone;
  readonly padded?: boolean;
  readonly elevated?: boolean;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}) {
  const inset = padded ? 0 : spacingTokens.lg;
  return (
    <section data-surface="card" data-testid={testId} style={cardStyle({ padded, tone, elevated })}>
      {(title || actions) && (
        <header
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.md,
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBlockEnd: description ? spacingTokens.xs : spacingTokens.lg,
            paddingInline: inset,
            paddingBlockStart: inset,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: spacingTokens.sm,
              minInlineSize: 0,
            }}
          >
            {icon ? <IconTile icon={icon} tone={iconTone} size="sm" /> : null}
            {title ? (
              <h2 style={{ ...typographyTokens.h3, color: colorTokens.textPrimary }}>{title}</h2>
            ) : null}
          </div>
          {actions}
        </header>
      )}
      {description ? (
        <p
          style={{
            margin: 0,
            marginBlockEnd: spacingTokens.lg,
            paddingInline: inset,
            ...typographyTokens.bodySm,
            color: colorTokens.textSecondary,
          }}
        >
          {description}
        </p>
      ) : null}
      {children}
      {footer ? (
        <footer
          style={{
            marginBlockStart: spacingTokens.lg,
            paddingBlockStart: spacingTokens.md,
            paddingInline: inset,
            paddingBlockEnd: inset,
            borderBlockStart: `1px solid ${colorTokens.hairline}`,
          }}
        >
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

/**
 * A single headline figure.
 *
 * `value` is a STRING the caller formats, and `unavailable` renders an honest
 * dash with an explanation instead. Nothing here invents a number, and there is
 * no default value to fall back to — a metric card with no data must say so.
 *
 * `trend` and `context` are OPTIONAL and are only ever passed where a real
 * comparison exists. A metric card is not permitted to imply a measurement the
 * product has not taken.
 */
export function MetricCard({
  label,
  value,
  hint,
  icon,
  iconTone = 'brand',
  trend,
  unavailable = false,
  unavailableLabel,
  accent = false,
  testId,
}: {
  readonly label: string;
  readonly value?: string | undefined;
  readonly hint?: string | undefined;
  readonly icon?: ReactNode;
  readonly iconTone?: 'brand' | 'accent' | 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  /** A real comparison, or nothing. Never a decorative arrow. */
  readonly trend?:
    { readonly direction: 'up' | 'down' | 'flat'; readonly label: string } | undefined;
  readonly unavailable?: boolean;
  readonly unavailableLabel?: string | undefined;
  /** Marks the card as the primary figure. Yellow accent, used once per row. */
  readonly accent?: boolean;
  readonly testId?: string | undefined;
}) {
  const trendColor =
    trend?.direction === 'up'
      ? colorTokens.success
      : trend?.direction === 'down'
        ? colorTokens.danger
        : colorTokens.textSecondary;

  /*
   * A LONG WORD IS NOT A HEADLINE FIGURE.
   *
   * `value` is a formatted string, and it is not always a number: a plan key
   * and an environment name render here too. At the reference's 32px numeric
   * step "DEVELOPMENT" broke across two lines mid-word. Wrapping keeps the
   * layout intact, but "DEVELOPME / NT" is not a fixed card — it is a broken
   * one that no longer overflows. A word this long simply gets the section
   * step instead, which fits and still reads as the card's headline.
   */
  const longWord = typeof value === 'string' && value.trim().length > 9;
  /*
   * The section step, not the view step. `h2` (29px) was the first answer and
   * it was still too wide: "DEVELOPMENT" at 29px does not fit the 228px a
   * four-across metric card leaves inside its padding, so it wrapped mid-word
   * — the exact failure F-36 was meant to end, one step smaller. 18px fits
   * with room to spare and still reads as the card's headline.
   */
  const valueType = longWord ? typographyTokens.h3 : typographyTokens.numeric;

  return (
    <div
      data-surface="card"
      data-testid={testId}
      style={{
        ...cardStyle({ tone: accent ? 'lavender' : 'plain' }),
        // A statistic is a SMALLER plane than a section card: 18px rather than
        // 28px, and a lighter shadow, because four of them sit in a row and the
        // section shadow repeated four times stops being subliminal.
        borderRadius: radiusTokens.card,
        background: colorTokens.metricAlpha,
        boxShadow: shadowTokens.metric,
        // `.metric { min-height: 118px; padding: 20px }`.
        minBlockSize: '7.375rem',
        padding: layoutTokens.metricPad,
        display: 'flex',
        flexDirection: 'column',
        gap: spacingTokens.sm,
        justifyContent: 'flex-start',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: spacingTokens.sm }}>
        {icon ? <IconTile icon={icon} tone={accent ? 'accent' : iconTone} size="sm" /> : null}
        {/* `.metric > span { color: var(--muted); font-size: 12px }` — a quiet
            caption, not a semibold label. The weight was doing work the 32px
            figure below it should be doing alone. */}
        <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>{label}</span>
      </div>
      <div style={{ display: 'grid', gap: 0, marginBlockStart: spacingTokens.sm }}>
        {/*
         * THE VALUE MUST NEVER SET THE CARD'S WIDTH.
         *
         * `value` is a string the caller formats, and it is not always a
         * number — a plan key renders here too. At the reference's 32px
         * numeric step the single word "DEVELOPMENT" is 253px, which pushed
         * the whole console 11px off the inline-end edge in Arabic. The
         * overflow suite caught it the moment the page-level clip that had
         * been hiding it was removed.
         */}
        {unavailable ? (
          <span
            data-testid={testId ? `${testId}-unavailable` : undefined}
            style={{
              ...typographyTokens.numeric,
              color: colorTokens.textMuted,
              minInlineSize: 0,
              overflowWrap: 'anywhere',
            }}
          >
            {'—'}
          </span>
        ) : (
          <span
            style={{
              ...valueType,
              color: colorTokens.textPrimary,
              minInlineSize: 0,
              overflowWrap: 'anywhere',
            }}
          >
            {value}
          </span>
        )}
        <div
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: spacingTokens.xs }}
        >
          {trend && !unavailable ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: spacingTokens['3xs'],
                ...typographyTokens.caption,
                fontWeight: 600,
                color: trendColor,
              }}
            >
              <span aria-hidden="true">
                {trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→'}
              </span>
              {trend.label}
            </span>
          ) : null}
          {(unavailable ? unavailableLabel : hint) ? (
            <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
              {unavailable ? unavailableLabel : hint}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The page header: exactly one `h1` per page, plus optional breadcrumbs and
 * page-level actions. Asserted by the accessibility suite.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  meta,
  eyebrow,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly actions?: ReactNode;
  readonly breadcrumbs?: ReactNode;
  /** Badges or status pills that belong beside the title. */
  readonly meta?: ReactNode;
  /** A small label above the title, for section context. */
  readonly eyebrow?: string | undefined;
}) {
  return (
    <div style={{ marginBlockEnd: spacingTokens.xl }}>
      {breadcrumbs}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: spacingTokens.md,
          alignItems: 'flex-start',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ minInlineSize: 0 }}>
          {eyebrow ? (
            <p
              style={{
                margin: 0,
                marginBlockEnd: spacingTokens['3xs'],
                ...typographyTokens.overline,
                textTransform: 'uppercase',
                // Muted, not purple. In the approved direction the eyebrow is a
                // quiet kicker that lets the title carry the weight; a coloured
                // one competes with the heading it is introducing.
                color: colorTokens.textMuted,
              }}
            >
              {eyebrow}
            </p>
          ) : null}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: spacingTokens.sm,
            }}
          >
            <h1
              data-testid="heading"
              style={{ ...typographyTokens.h1, color: colorTokens.textPrimary }}
            >
              {title}
            </h1>
            {meta}
          </div>
          {description ? (
            <p
              data-testid="description"
              style={{
                margin: 0,
                marginBlockStart: spacingTokens.xs,
                maxInlineSize: '62ch',
                ...typographyTokens.body,
                color: colorTokens.textSecondary,
              }}
            >
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

/** A heading inside a page, above a group of cards. */
export function SectionHeader({
  title,
  description,
  actions,
  icon,
  eyebrow,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly actions?: ReactNode;
  readonly icon?: ReactNode;
  /**
   * The reference's `.section-kicker` — a heavily tracked uppercase word above
   * the section title. It names the KIND of thing below it ("Upcoming",
   * "Copilot") where the title names the thing itself, which is how the
   * reference gets two levels of heading out of one line of small type.
   *
   * A `span`, not a heading: it would otherwise insert a level into the
   * document outline for a word that is not a section of its own.
   */
  readonly eyebrow?: string | undefined;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        // `.section-head { align-items: flex-start; gap: 12px; margin-bottom: 18px }`.
        gap: spacingTokens.sm,
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        marginBlockEnd: layoutTokens.sectionGap,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: spacingTokens.sm,
          minInlineSize: 0,
        }}
      >
        {icon ? <IconTile icon={icon} size="sm" tone="neutral" /> : null}
        <div>
          {eyebrow ? (
            <span
              style={{
                display: 'block',
                ...typographyTokens.overline,
                textTransform: 'uppercase',
                color: colorTokens.textMuted,
              }}
            >
              {eyebrow}
            </span>
          ) : null}
          {/* `.section-head h3 { margin: 5px 0 0 }`. */}
          {/* `.section-head h3 { margin: 4px 0 0; font-size: 18px }`. The 29px
              step is `.view-toolbar h2`, the PAGE-level title, not this one. */}
          <h2
            style={{
              marginBlockStart: eyebrow ? spacingTokens.xs : 0,
              ...typographyTokens.h3,
              color: colorTokens.textPrimary,
            }}
          >
            {title}
          </h2>
          {description ? (
            <p
              style={{
                margin: 0,
                marginBlockStart: spacingTokens['3xs'],
                ...typographyTokens.bodySm,
                color: colorTokens.textSecondary,
              }}
            >
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {actions}
    </div>
  );
}

/**
 * A responsive grid that needs no media query.
 *
 * `repeat(auto-fit, minmax(min(<min>, 100%), 1fr))` reflows from four columns
 * to one as the viewport narrows, and the `min()` is what stops a track from
 * being wider than the viewport at 390px — the exact shape that used to produce
 * horizontal overflow.
 */
export function ContentGrid({
  min = '16rem',
  // `.metric-row { gap: 12px }`.
  gap = spacingTokens.sm,
  children,
  testId,
}: {
  readonly min?: string;
  readonly gap?: string;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}, 100%), 1fr))`,
        gap,
      }}
    >
      {children}
    </div>
  );
}

/** Vertical rhythm between page sections, so pages do not each invent a margin. */
export function Stack({
  // `.metric-row { margin: 18px 0 }` and `.dashboard-grid { gap: 18px }`.
  gap = layoutTokens.sectionGap,
  children,
}: {
  readonly gap?: string;
  readonly children: ReactNode;
}) {
  return <div style={{ display: 'grid', gap, alignContent: 'start' }}>{children}</div>;
}

/**
 * A hero surface: the one place a restrained purple wash is permitted.
 *
 * Used by sign-in and by onboarding-shaped moments, never as a page ground —
 * the canvas stays white (D-50). The wash is a soft radial tint, not a
 * gradient stack, and it carries no text of its own by default.
 */
export function HeroSurface({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: radiusTokens['2xl'],
        background: `radial-gradient(120% 120% at 100% 0%, ${colorTokens.surfaceLavenderStrong} 0%, ${colorTokens.surfaceLavender} 45%, ${colorTokens.surface} 100%)`,
        padding: spacingTokens.xl,
      }}
    >
      {children}
    </div>
  );
}

/**
 * THE SETTINGS SPLIT (`.settings-grid`), §25.
 *
 * `grid-template-columns: 220px 1fr; gap: 13px`, with the nav and the form as
 * two soft-shadowed surfaces — `.settings-nav, .settings-form { background:
 * rgba(255,255,255,.8); border-radius: 19px; padding: 14px }`. The nav's rows
 * are `border-radius: 10px; padding: 10px; text-align: start; font-size: 9px`,
 * and the selected one takes the muted fill at weight 800.
 *
 * Every entry is a REAL destination the caller can actually reach. The demo's
 * nav lists sections this phase does not have, and inventing rows that lead
 * nowhere is the placeholder link §20 rules out — so the list is whatever the
 * app passes, filtered by permission before it gets here.
 */
export function SettingsSplit({
  navLabel,
  items,
  children,
  testId,
}: {
  readonly navLabel: string;
  readonly items: readonly {
    readonly href: string;
    readonly label: string;
    readonly selected: boolean;
  }[];
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}) {
  return (
    <div className="bs-settings-split" data-testid={testId ?? 'settings-split'}>
      <nav
        aria-label={navLabel}
        data-testid="settings-nav"
        style={{
          display: 'grid',
          alignContent: 'start',
          gap: spacingTokens['3xs'],
          padding: '0.875rem',
          borderRadius: radiusTokens['2xl'],
          background: colorTokens.surfaceCardAlpha,
          boxShadow: shadowTokens.card,
        }}
      >
        {items.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="bs-pressable"
            aria-current={item.selected ? 'page' : undefined}
            style={{
              display: 'block',
              padding: spacingTokens.sm,
              borderRadius: radiusTokens.md,
              textDecoration: 'none',
              ...typographyTokens.caption,
              fontWeight: item.selected ? 800 : 400,
              color: colorTokens.textPrimary,
              background: item.selected ? colorTokens.surfaceMuted : 'transparent',
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <div style={{ minInlineSize: 0, display: 'grid', gap: spacingTokens.sm }}>{children}</div>
    </div>
  );
}
