import type { CSSProperties, ReactNode } from 'react';
import { colorTokens, radiusTokens, shadowTokens, spacingTokens, typographyTokens } from './tokens';
import { AlertIcon, CheckIcon, EmptyBoxIcon, InfoIcon, LockIcon, SearchIcon } from './icons';

/**
 * Feedback and non-content states.
 *
 * A product is mostly not the happy path. Empty, error, permission-denied,
 * no-results and loading each get a real component here, because the
 * alternative — each page inventing a paragraph — is how "no data yet" ends up
 * looking like a bug and a permission refusal ends up looking like an outage.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL (WCAG 1.4.1): every tone carries an icon and
 * a word as well as a hue.
 */

export type Tone = 'success' | 'error' | 'warning' | 'info';

interface ToneStyle {
  readonly background: string;
  readonly color: string;
  readonly border: string;
  readonly icon: ReactNode;
}

function toneStyle(tone: Tone): ToneStyle {
  switch (tone) {
    case 'success':
      return {
        background: colorTokens.successTint,
        color: colorTokens.success,
        border: colorTokens.successBorder,
        icon: <CheckIcon size={18} />,
      };
    case 'error':
      return {
        background: colorTokens.dangerTint,
        color: colorTokens.danger,
        border: colorTokens.dangerBorder,
        icon: <AlertIcon size={18} />,
      };
    case 'warning':
      return {
        background: colorTokens.warningTint,
        color: colorTokens.warning,
        border: colorTokens.warningBorder,
        icon: <AlertIcon size={18} />,
      };
    case 'info':
      return {
        background: colorTokens.infoTint,
        color: colorTokens.info,
        border: colorTokens.infoBorder,
        icon: <InfoIcon size={18} />,
      };
  }
}

/**
 * Inline feedback for the `?ok=` / `?error=` status codes the server actions
 * emit. `role="status"` so it is announced without stealing focus.
 */
export function Banner({
  tone,
  children,
  testId,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}) {
  const style = toneStyle(tone);
  const defaultTestId = tone === 'success' ? 'success-banner' : 'error-banner';
  return (
    <div
      role="status"
      data-testid={testId ?? defaultTestId}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: spacingTokens.sm,
        margin: 0,
        marginBlockEnd: spacingTokens.md,
        padding: spacingTokens.sm,
        paddingInline: spacingTokens.md,
        borderRadius: radiusTokens.lg,
        ...typographyTokens.bodySm,
        background: style.background,
        color: style.color,
        // Filled, not outlined. The icon and the wording carry the tone as well
        // as the colour, so nothing here depends on a stroke (WCAG 1.4.1).
        border: '1px solid transparent',
      }}
    >
      <span style={{ flexShrink: 0, display: 'inline-flex', marginBlockStart: '1px' }}>
        {style.icon}
      </span>
      <span style={{ minInlineSize: 0 }}>{children}</span>
    </div>
  );
}

/**
 * A transient message anchored to the viewport corner.
 *
 * `aria-live="polite"` and `role="status"`, never `alert`: a confirmation that
 * interrupts a screen-reader user mid-sentence is worse than one that waits.
 * Dismissal is the caller's business — this component does not own a timer,
 * because a message that vanishes before it can be read is not feedback.
 */
export function Toast({
  tone,
  children,
  onDismiss,
  dismissLabel,
  testId,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
  readonly onDismiss?: (() => void) | undefined;
  readonly dismissLabel?: string | undefined;
  readonly testId?: string | undefined;
}) {
  const style = toneStyle(tone);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId ?? 'toast'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: spacingTokens.sm,
        maxInlineSize: '24rem',
        padding: spacingTokens.md,
        borderRadius: radiusTokens.lg,
        background: colorTokens.surface,
        border: '1px solid transparent',
        boxShadow: shadowTokens.overlay,
        ...typographyTokens.bodySm,
        color: colorTokens.textPrimary,
      }}
    >
      <span style={{ color: style.color, flexShrink: 0, display: 'inline-flex' }}>
        {style.icon}
      </span>
      <span style={{ minInlineSize: 0, flex: 1 }}>{children}</span>
      {onDismiss && dismissLabel ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          style={{
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            color: colorTokens.textSecondary,
            fontSize: typographyTokens.bodySm.fontSize,
            minInlineSize: '24px',
            minBlockSize: '24px',
          }}
        >
          {'×'}
        </button>
      ) : null}
    </div>
  );
}

type StateKind = 'empty' | 'no-results' | 'error' | 'forbidden';

function stateIcon(kind: StateKind): ReactNode {
  switch (kind) {
    case 'no-results':
      return <SearchIcon size={22} />;
    case 'error':
      return <AlertIcon size={22} />;
    case 'forbidden':
      return <LockIcon size={22} />;
    case 'empty':
      return <EmptyBoxIcon size={22} />;
  }
}

/**
 * The one component for every "there is nothing to show" case.
 *
 * `kind` distinguishes them because they are NOT the same message: an empty
 * collection invites you to create something, no search results invite you to
 * change the query, an error invites a retry, and a permission refusal invites
 * nothing at all. Collapsing them into one grey paragraph is how a product
 * makes a refusal look like a failure.
 *
 * NOTE ON `forbidden`: the customer application answers a missing permission
 * with 404, not 403 (docs/SECURITY.md §2.3), so this state is for surfaces that
 * legitimately show a disabled capability — not for hiding a route.
 */
export function StateMessage({
  kind = 'empty',
  title,
  description,
  action,
  testId,
}: {
  readonly kind?: StateKind;
  readonly title: string;
  readonly description?: string | undefined;
  readonly action?: ReactNode;
  readonly testId?: string | undefined;
}) {
  const defaultTestId =
    kind === 'no-results'
      ? 'no-results-state'
      : kind === 'error'
        ? 'error-state'
        : kind === 'forbidden'
          ? 'forbidden-state'
          : 'empty-state';
  return (
    <div
      data-testid={testId ?? defaultTestId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: spacingTokens.sm,
        padding: spacingTokens['2xl'],
        paddingInline: spacingTokens.md,
        // A soft filled well, not a dashed box. A dashed outline reads as a
        // drop target or an unfinished screen; this reads as a calm blank.
        background: colorTokens.surfaceSoft,
        borderRadius: radiusTokens.xl,
        color: colorTokens.textSecondary,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          inlineSize: '3rem',
          blockSize: '3rem',
          borderRadius: radiusTokens.full,
          background: kind === 'error' ? colorTokens.dangerTint : colorTokens.surfaceLavenderStrong,
          color: kind === 'error' ? colorTokens.danger : colorTokens.brandPurplePressed,
        }}
      >
        {stateIcon(kind)}
      </span>
      <span style={{ ...typographyTokens.h3, color: colorTokens.textPrimary }}>{title}</span>
      {description ? (
        <span style={{ ...typographyTokens.bodySm, maxInlineSize: '44ch' }}>{description}</span>
      ) : null}
      {action ? <span style={{ marginBlockStart: spacingTokens.xs }}>{action}</span> : null}
    </div>
  );
}

/**
 * A loading placeholder.
 *
 * `aria-hidden` with a sibling live region owned by the caller: a screen reader
 * announcing "loading loading loading" for a list of twelve skeleton rows is
 * noise, and the useful announcement is one status message, not twelve.
 */
export function Skeleton({
  width = '100%',
  height = '1rem',
  radius = radiusTokens.sm,
  style,
}: {
  readonly width?: string;
  readonly height?: string;
  readonly radius?: string;
  readonly style?: CSSProperties | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="skeleton"
      style={{
        display: 'block',
        inlineSize: width,
        blockSize: height,
        borderRadius: radius,
        background: colorTokens.surfaceSunken,
        ...style,
      }}
    />
  );
}

/** Several skeleton lines, for a card or a table body. */
export function SkeletonLines({ lines = 3 }: { readonly lines?: number }) {
  return (
    <div style={{ display: 'grid', gap: spacingTokens.sm }}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={index === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}
