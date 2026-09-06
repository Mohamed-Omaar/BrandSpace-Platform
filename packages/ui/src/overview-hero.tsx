import type { ReactNode } from 'react';

import {
  colorTokens,
  gradientTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from './tokens';

/**
 * THE OVERVIEW HERO (§5 of the brief, D-59).
 *
 * Explicitly approved and explicitly not to be reduced to a row of ordinary
 * dashboard cards, so it is a component of its own rather than a `Card` with a
 * larger heading. It reproduces the reference's `.hero-card`: a two-column
 * gradient plane, a label pill, a display-scale statement, one supporting line,
 * a filled primary action beside a quiet text action, and a soft orbit panel.
 *
 * WHY THE ORBIT CARRIES NO CONTENT. The reference floats two post cards in it,
 * captioned "Product launch · Instagram · Today" and "Behind the scenes ·
 * TikTok · Tomorrow". Those are invented — there is no Post model, no connected
 * account and no schedule behind them, and CLAUDE.md §2.2 does not allow a
 * screen to imply data the product has not got. So the composition is
 * reproduced and the fabricated captions are not: the floating cards are
 * abstract shapes, the whole panel is `aria-hidden`, and every number on this
 * page comes from a real query or says plainly that it is unavailable.
 *
 * WHY THE GRADIENT IS SAFE. Text sits only in the inline-start column, over the
 * pale middle of the wash (`rgba(255,255,255,.65)` at 42%), and the two token
 * colours it can resolve to are asserted against `textPrimary` and
 * `textSecondary` in `tests/unit/contrast.test.ts`. The saturated ends of the
 * gradient are behind the orbit, where nothing is legible by design.
 */
export function OverviewHero({
  eyebrow,
  title,
  description,
  primaryAction,
  secondaryAction,
  isPageTitle = false,
  testId = 'overview-hero',
}: {
  /** A short scope label — "this week", the workspace name. Never a metric. */
  readonly eyebrow?: string | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  readonly primaryAction?: ReactNode;
  readonly secondaryAction?: ReactNode;
  /**
   * Renders the statement as the page's `h1`.
   *
   * ON THE OVERVIEW THE HERO **IS** THE PAGE TITLE, so it takes the `h1` and
   * the shell renders no separate header above it — otherwise the page would
   * open with a small "Home" heading and then repeat itself at display scale
   * two lines later, which is both redundant and a second top-level heading.
   * Everywhere else the hero is a section and takes an `h2`.
   */
  readonly isPageTitle?: boolean;
  readonly testId?: string | undefined;
}) {
  const Title = isPageTitle ? 'h1' : 'h2';
  return (
    <section
      data-testid={testId}
      className="bs-hero"
      style={{
        position: 'relative',
        overflow: 'hidden',
        display: 'grid',
        borderRadius: radiusTokens['2xl'],
        background: gradientTokens.hero,
        boxShadow: '0 18px 50px rgba(48, 31, 88, 0.08)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: spacingTokens.sm,
          padding: 'clamp(1.75rem, 4vw, 3.875rem)',
          minInlineSize: 0,
        }}
      >
        {eyebrow ? (
          <span
            style={{
              padding: `${spacingTokens['2xs']} ${spacingTokens.sm}`,
              borderRadius: radiusTokens.full,
              // Translucent white on the wash, so the pill picks up whatever
              // the gradient is doing behind it rather than fighting it.
              background: 'rgba(255, 255, 255, 0.72)',
              ...typographyTokens.caption,
              fontWeight: 800,
              color: colorTokens.textPrimary,
            }}
          >
            {eyebrow}
          </span>
        ) : null}

        <Title
          data-testid={isPageTitle ? 'heading' : `${testId}-title`}
          style={{
            // 600px in the reference: two confident lines, not three.
            maxInlineSize: '37.5rem',
            marginBlock: spacingTokens.xs,
            ...typographyTokens.display,
            color: colorTokens.textPrimary,
          }}
        >
          {title}
        </Title>

        {description ? (
          <p
            data-testid={isPageTitle ? 'description' : undefined}
            style={{
              margin: 0,
              maxInlineSize: '46ch',
              ...typographyTokens.body,
              color: colorTokens.textSecondary,
            }}
          >
            {description}
          </p>
        ) : null}

        {primaryAction || secondaryAction ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: spacingTokens.md,
              marginBlockStart: spacingTokens.md,
            }}
          >
            {primaryAction}
            {secondaryAction}
          </div>
        ) : null}
      </div>

      {/*
       * Decoration, and nothing else. `aria-hidden` because there is nothing
       * here for a screen reader to be told about — it is the shape of the
       * approved composition, not information.
       */}
      <div className="bs-hero-orbit" aria-hidden="true" style={{ position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            inlineSize: '21.25rem',
            blockSize: '21.25rem',
            insetInlineEnd: '10%',
            insetBlockStart: '6%',
            borderRadius: '50%',
            background: 'rgba(255, 255, 255, 0.3)',
            boxShadow: 'inset 0 0 0 50px rgba(255, 255, 255, 0.15)',
          }}
        />
        <FloatingTile
          gradient={`linear-gradient(145deg, ${colorTokens.brandPurple}, #D3BAFF)`}
          style={{ insetBlockStart: '3rem', insetInlineStart: '12%', transform: 'rotate(-4deg)' }}
        />
        <FloatingTile
          gradient={`linear-gradient(145deg, ${colorTokens.brandYellow}, #FFF4A7)`}
          style={{ insetBlockEnd: '2.625rem', insetInlineEnd: '8%', transform: 'rotate(5deg)' }}
        />
      </div>
    </section>
  );
}

/** One of the two abstract cards floating in the orbit. Shapes, not content. */
function FloatingTile({
  gradient,
  style,
}: {
  readonly gradient: string;
  readonly style: React.CSSProperties;
}) {
  return (
    <span
      style={{
        position: 'absolute',
        zIndex: 2,
        inlineSize: '13.125rem',
        minBlockSize: '6.125rem',
        padding: spacingTokens.md,
        display: 'grid',
        gridTemplateColumns: '2.125rem 1fr',
        gap: `${spacingTokens['3xs']} ${spacingTokens.sm}`,
        alignItems: 'center',
        background: 'rgba(255, 255, 255, 0.87)',
        borderRadius: radiusTokens.xl,
        boxShadow: '0 20px 40px rgba(44, 20, 90, 0.12)',
        ...style,
      }}
    >
      <span
        style={{
          gridRow: 'span 2',
          inlineSize: '2.125rem',
          blockSize: '3.125rem',
          borderRadius: radiusTokens.sm,
          background: gradient,
        }}
      />
      {/* Two neutral bars where the reference puts a title and a timestamp.
          A shape cannot claim a post exists; a caption would. */}
      <span
        style={{
          blockSize: '0.5rem',
          inlineSize: '75%',
          borderRadius: radiusTokens.full,
          background: colorTokens.surfaceMuted,
        }}
      />
      <span
        style={{
          gridColumn: 2,
          blockSize: '0.5rem',
          inlineSize: '50%',
          borderRadius: radiusTokens.full,
          background: colorTokens.surfaceSoft,
        }}
      />
    </span>
  );
}
