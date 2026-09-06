import type { ReactNode } from 'react';

import {
  colorTokens,
  gradientTokens,
  layoutTokens,
  radiusTokens,
  shadowTokens,
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
  visual,
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
  /** The hero's right-hand column — two `HeroFloatCard`s in the demo. */
  readonly visual?: ReactNode;
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
        borderRadius: radiusTokens['3xl'],
        background: gradientTokens.hero,
        boxShadow: shadowTokens.card,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          // `.hero-copy { padding: 48px }` — a fixed inset, not a fluid one.
          gap: 0,
          padding: layoutTokens.heroPad,
          minInlineSize: 0,
        }}
      >
        {eyebrow ? (
          <span
            style={{
              // `.label-pill { padding: 7px 10px; font-size: 9px; weight: 800;
              //  background: rgba(255,255,255,.68) }`.
              padding: '0.4375rem 0.625rem',
              borderRadius: radiusTokens.full,
              // Translucent white on the wash, so the pill picks up whatever
              // the gradient is doing behind it rather than fighting it.
              background: 'rgba(255, 255, 255, 0.68)',
              ...typographyTokens.overline,
              letterSpacing: 'normal',
              textTransform: 'none',
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
            // `.hero-copy h2 { max-width: 620px; margin: 16px 0 10px }`.
            maxInlineSize: '38.75rem',
            marginBlockStart: spacingTokens.md,
            marginBlockEnd: '0.625rem',
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
              // `.hero-copy p { max-width: 500px; margin: 0 0 24px }`, 15px/1.6.
              margin: 0,
              marginBlockEnd: spacingTokens.lg,
              maxInlineSize: '31.25rem',
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
              // `.hero-actions { gap: 12px }` — the copy's own bottom margin
              // provides the space above, so there is no extra top margin.
              gap: '0.75rem',
              marginBlockStart: 0,
            }}
          >
            {primaryAction}
            {secondaryAction}
          </div>
        ) : null}
      </div>

      {/*
       * `.hero-visual` — two `.float-card`s, 220px wide, 15px padding, 20px
       * radius, `rgba(255,255,255,.8)` with a 14px backdrop blur and a
       * violet-tinted shadow. `:first-child { right: 12%; top: 20% }`,
       * `:nth-child(2) { left: 4%; bottom: 16% }`.
       *
       * The demo captions them "Performance this month / Engagement is up
       * 18.4%" and "Next to publish / Collection launch · Today 09:00". Those
       * are measurements of a publishing pipeline this phase does not have, so
       * the BOXES are reproduced exactly and the CONTENT is honest (§33): each
       * card says what it will hold and that it holds nothing yet.
       */}
      <div className="bs-hero-orbit" style={{ position: 'relative' }}>
        {visual}
      </div>
    </section>
  );
}

/**
 * One of the hero's two floating cards.
 *
 * `.float-card b, .float-card small { display: block }`,
 * `.float-card small { color: var(--muted); font-size: 9px; margin-top: 5px }`.
 */
export function HeroFloatCard({
  title,
  detail,
  placement,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly placement: 'start' | 'end';
  readonly children?: ReactNode;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inlineSize: '13.75rem',
        padding: '0.9375rem',
        borderRadius: radiusTokens.card,
        background: colorTokens.floatCardAlpha,
        backdropFilter: 'blur(14px)',
        boxShadow: shadowTokens.float,
        ...(placement === 'end'
          ? { insetInlineEnd: '12%', insetBlockStart: '20%' }
          : { insetInlineStart: '4%', insetBlockEnd: '16%' }),
      }}
    >
      <b style={{ display: 'block', ...typographyTokens.bodySm, fontWeight: 700 }}>{title}</b>
      <small
        style={{
          display: 'block',
          marginBlockStart: '0.3125rem',
          ...typographyTokens.caption,
          color: colorTokens.textMuted,
        }}
      >
        {detail}
      </small>
      {children}
    </div>
  );
}

/**
 * `.mini-chart` — four bars at fixed CSS heights, 60px tall, 5px apart, the
 * fourth in purple. DECORATION, and `aria-hidden`: the heights are literals in
 * the demo's stylesheet, not values, and the card above it says in words that
 * there is nothing measured yet.
 */
export function HeroMiniChart() {
  const bars = ['45%', '82%', '55%', '95%'];
  return (
    <div
      aria-hidden="true"
      style={{
        blockSize: '3.75rem',
        marginBlockStart: '0.625rem',
        display: 'flex',
        alignItems: 'end',
        gap: '0.3125rem',
      }}
    >
      {bars.map((height, index) => (
        <i
          key={height}
          style={{
            flex: 1,
            blockSize: height,
            borderRadius: '6px 6px 2px 2px',
            background: index === 3 ? colorTokens.brandPurple : colorTokens.ink,
          }}
        />
      ))}
    </div>
  );
}
