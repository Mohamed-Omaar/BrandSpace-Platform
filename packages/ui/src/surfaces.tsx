import type { CSSProperties, ReactNode } from 'react';
import { colorTokens, radiusTokens, shadowTokens, spacingTokens, typographyTokens } from './tokens';
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
  plain: colorTokens.surface,
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
    borderRadius: radiusTokens.xl,
    // A hairline, not a border: on a white card it is invisible at rest and
    // becomes a real 3:1 edge under `prefers-contrast: more` (tokens.css).
    border: `1px solid ${tone === 'plain' ? colorTokens.hairline : 'transparent'}`,
    boxShadow: elevated ? shadowTokens.card : 'none',
    padding: padded ? spacingTokens.lg : 0,
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
    <section data-testid={testId} style={cardStyle({ padded, tone, elevated })}>
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
              <h2 style={{ ...typographyTokens.h2, color: colorTokens.textPrimary }}>{title}</h2>
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

  return (
    <div
      data-testid={testId}
      style={{
        ...cardStyle({ tone: accent ? 'lavender' : 'plain' }),
        display: 'flex',
        flexDirection: 'column',
        gap: spacingTokens.sm,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: spacingTokens.sm }}>
        {icon ? <IconTile icon={icon} tone={accent ? 'accent' : iconTone} size="sm" /> : null}
        <span style={{ ...typographyTokens.label, color: colorTokens.textSecondary }}>{label}</span>
      </div>
      {unavailable ? (
        <span
          data-testid={testId ? `${testId}-unavailable` : undefined}
          style={{ ...typographyTokens.numeric, color: colorTokens.textMuted }}
        >
          {'—'}
        </span>
      ) : (
        <span style={{ ...typographyTokens.numeric, color: colorTokens.textPrimary }}>{value}</span>
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
                color: colorTokens.brandPurple,
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
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly actions?: ReactNode;
  readonly icon?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: spacingTokens.sm,
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBlockEnd: spacingTokens.md,
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: spacingTokens.sm, minInlineSize: 0 }}
      >
        {icon ? <IconTile icon={icon} size="sm" tone="neutral" /> : null}
        <div>
          <h2 style={{ ...typographyTokens.h2, color: colorTokens.textPrimary }}>{title}</h2>
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
  gap = spacingTokens.md,
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
  gap = spacingTokens.lg,
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
