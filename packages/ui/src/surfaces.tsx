import type { CSSProperties, ReactNode } from 'react';
import { colorTokens, radiusTokens, shadowTokens, spacingTokens, typographyTokens } from './tokens';

/**
 * Surfaces and structure: cards, metric cards, page and section headers, grids.
 *
 * The approved direction is "clean white surfaces, subtle neutral borders,
 * restrained shadows, modern rounded corners, deliberate whitespace" — and the
 * ground is white too (D-49). Separation therefore comes from ONE border plus
 * ONE subtle shadow, not from a tinted page background. Every card in the
 * product renders through this file, so that decision is reversible in one edit.
 */

export function cardStyle(
  options: { padded?: boolean; interactive?: boolean } = {},
): CSSProperties {
  const { padded = true } = options;
  return {
    background: colorTokens.surface,
    border: `1px solid ${colorTokens.cardBorder}`,
    borderRadius: radiusTokens.lg,
    boxShadow: shadowTokens.card,
    padding: padded ? spacingTokens.lg : 0,
    // Belt to the `Stack` braces: a card must be allowed to be narrower than
    // its widest child, because that child is expected to scroll inside itself.
    minInlineSize: 0,
  };
}

export function Card({
  title,
  description,
  actions,
  footer,
  padded = true,
  children,
  testId,
}: {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly padded?: boolean;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}) {
  return (
    <section data-testid={testId} style={cardStyle({ padded })}>
      {(title || actions) && (
        <header
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.sm,
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBlockEnd: description ? spacingTokens.xs : spacingTokens.md,
            paddingInline: padded ? 0 : spacingTokens.lg,
            paddingBlockStart: padded ? 0 : spacingTokens.lg,
          }}
        >
          {title ? (
            <h2 style={{ ...typographyTokens.h2, color: colorTokens.textPrimary }}>{title}</h2>
          ) : (
            <span />
          )}
          {actions}
        </header>
      )}
      {description ? (
        <p
          style={{
            margin: 0,
            marginBlockEnd: spacingTokens.md,
            paddingInline: padded ? 0 : spacingTokens.lg,
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
            marginBlockStart: spacingTokens.md,
            paddingBlockStart: spacingTokens.md,
            paddingInline: padded ? 0 : spacingTokens.lg,
            paddingBlockEnd: padded ? 0 : spacingTokens.lg,
            borderBlockStart: `1px solid ${colorTokens.cardBorder}`,
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
 * no default value to fall back to — a metric card with no data must say so
 * (CLAUDE.md §4 of the Phase 2B brief: honest zero, empty or unavailable states).
 */
export function MetricCard({
  label,
  value,
  hint,
  unavailable = false,
  unavailableLabel,
  accent = false,
  testId,
}: {
  readonly label: string;
  readonly value?: string | undefined;
  readonly hint?: string | undefined;
  readonly unavailable?: boolean;
  readonly unavailableLabel?: string | undefined;
  /** Marks the card as the primary figure on the page. Yellow accent rule. */
  readonly accent?: boolean;
  readonly testId?: string | undefined;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        ...cardStyle(),
        display: 'flex',
        flexDirection: 'column',
        gap: spacingTokens.xs,
        // The accent is a 3px inline-start mark in yellow: an accent, never a
        // yellow surface carrying text.
        borderInlineStartWidth: accent ? '3px' : '1px',
        borderInlineStartColor: accent ? colorTokens.brandYellow : colorTokens.cardBorder,
      }}
    >
      <span style={{ ...typographyTokens.label, color: colorTokens.textSecondary }}>{label}</span>
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
      {(unavailable ? unavailableLabel : hint) ? (
        <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
          {unavailable ? unavailableLabel : hint}
        </span>
      ) : null}
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
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly actions?: ReactNode;
  readonly breadcrumbs?: ReactNode;
  /** Badges or status pills that belong beside the title. */
  readonly meta?: ReactNode;
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
                maxInlineSize: '60ch',
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
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly actions?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: spacingTokens.sm,
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBlockEnd: spacingTokens.md,
      }}
    >
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
      {actions}
    </div>
  );
}

/**
 * A responsive grid that needs no media query.
 *
 * `repeat(auto-fit, minmax(min, 1fr))` reflows from four columns to one as the
 * viewport narrows, and `minmax(min(<min>, 100%), 1fr)` is what stops the track
 * from being wider than the viewport at 390px — the exact shape that used to
 * produce horizontal overflow.
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
  return (
    <div
      style={{
        display: 'grid',
        // `minmax(0, 1fr)`, not the implicit `auto`. A grid item's default
        // `min-width: auto` floors it at its MIN-CONTENT width, so a card
        // containing a table with a `min-inline-size` grew to that table's
        // minimum and pushed the page sideways — 204px of horizontal scroll at
        // 768px, which the responsive suite caught.
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap,
        alignContent: 'start',
      }}
    >
      {children}
    </div>
  );
}
