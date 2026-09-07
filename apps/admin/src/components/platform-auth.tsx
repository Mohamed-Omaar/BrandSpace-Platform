import type { ReactNode } from 'react';
import {
  AmbientBackground,
  BrandMark,
  ShieldIcon,
  colorTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';

/**
 * The Platform Admin's unauthenticated shell: sign-in and the MFA challenge.
 *
 * WHAT IT REPLACES. Both pages were raw markup — browser-default inputs, a blue
 * button and an `h1` in `brandBlueText` — from before the design system
 * existed. They are the first screen an operator sees, and they looked like a
 * different product from the console behind them.
 *
 * DELIBERATELY NOT the customer's sign-in. This is an internal tool: no
 * marketing panel, no benefits list, a shield rather than a brand flourish, and
 * a narrower card. The realms are separate everywhere else in the system
 * (`docs/SECURITY.md` §2), and looking the same would be the wrong signal.
 *
 * The landmarks the accessibility suite asserts are unchanged: one `main` with
 * `id="main"` for the skip link, exactly one `h1`, and `data-testid="heading"`.
 */
export function PlatformAuthShell({
  heading,
  description,
  descriptionTestId,
  error,
  children,
}: {
  readonly heading: string;
  readonly description: string;
  /** The suites address the two pages' descriptions by different ids. */
  readonly descriptionTestId: string;
  readonly error?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <main
      id="main"
      style={{
        minBlockSize: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacingTokens.lg,
      }}
    >
      {/* Platform Admin shares the ground and the geometry, never the layout:
          the realms stay visually distinct, which is the point of D-58. */}
      <AmbientBackground />
      <div
        style={{
          inlineSize: '100%',
          maxInlineSize: '24rem',
          display: 'grid',
          gap: spacingTokens.lg,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <BrandMark title="BrandSpace" />
        </div>

        <div
          data-testid="platform-auth-card"
          style={{
            background: colorTokens.surface,
            borderRadius: radiusTokens['2xl'],
            boxShadow: shadowTokens.raised,
            padding: spacingTokens.xl,
            display: 'grid',
            gap: spacingTokens.md,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              inlineSize: '2.5rem',
              blockSize: '2.5rem',
              borderRadius: radiusTokens.lg,
              background: colorTokens.surfaceLavender,
              color: colorTokens.brandPurple,
            }}
          >
            <ShieldIcon size={20} />
          </span>

          <div style={{ display: 'grid', gap: spacingTokens.xs }}>
            <h1 data-testid="heading" style={{ ...typographyTokens.h1, margin: 0 }}>
              {heading}
            </h1>
            <p
              data-testid={descriptionTestId}
              style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
            >
              {description}
            </p>
          </div>

          {error}
          {children}
        </div>
      </div>
    </main>
  );
}
