import type { CSSProperties, ReactNode } from 'react';
import {
  colorTokens,
  radiusTokens,
  scrollContainerStyle,
  shadowTokens,
  spacingTokens,
} from '@brandspace/ui';

/**
 * Shared Control Center primitives for the Phase 2B surfaces.
 *
 * The approved visual direction (D-42) lives HERE, once: white cards on a
 * `#FAFAFA` ground, subtle borders, one restrained shadow, purple for primary
 * actions and selected states, yellow for accents. Pages compose these instead
 * of repeating colour literals, so the direction can change in one file rather
 * than in twenty (CLAUDE.md §4: colours are tokens, never literals).
 *
 * Every layout property is LOGICAL (`padding-inline`, `margin-block`,
 * `border-inline-start`), so Arabic RTL mirrors without a second stylesheet.
 */

export function Card({
  title,
  description,
  actions,
  children,
  testId,
}: {
  title?: string | undefined;
  description?: string | undefined;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string | undefined;
}) {
  return (
    <section
      data-testid={testId}
      style={{
        background: colorTokens.surface,
        border: `1px solid ${colorTokens.cardBorder}`,
        borderRadius: radiusTokens.lg,
        boxShadow: shadowTokens.card,
        padding: spacingTokens.lg,
        marginBlockEnd: spacingTokens.lg,
      }}
    >
      {(title || actions) && (
        <header
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.sm,
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBlockEnd: description ? spacingTokens.xs : spacingTokens.md,
          }}
        >
          {title && <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{title}</h2>}
          {actions}
        </header>
      )}
      {description && (
        <p
          style={{
            margin: 0,
            marginBlockEnd: spacingTokens.md,
            color: colorTokens.textSecondary,
            fontSize: '0.875rem',
          }}
        >
          {description}
        </p>
      )}
      {children}
    </section>
  );
}

const BUTTON_BASE: CSSProperties = {
  minBlockSize: '36px',
  paddingInline: spacingTokens.md,
  paddingBlock: '8px',
  borderRadius: radiusTokens.md,
  fontSize: '0.875rem',
  cursor: 'pointer',
};

/** Primary action. Purple surface, white ink — 5.60:1, AA at every size. */
export function primaryButtonStyle(): CSSProperties {
  return {
    ...BUTTON_BASE,
    background: colorTokens.brandPurple,
    color: colorTokens.brandPurpleInk,
    border: `1px solid ${colorTokens.brandPurple}`,
  };
}

export function secondaryButtonStyle(): CSSProperties {
  return {
    ...BUTTON_BASE,
    background: colorTokens.surface,
    color: colorTokens.textPrimary,
    border: `1px solid ${colorTokens.border}`,
  };
}

/** Destructive/high-impact. Never the default, never the only styling signal. */
export function dangerButtonStyle(): CSSProperties {
  return {
    ...BUTTON_BASE,
    background: colorTokens.surface,
    color: colorTokens.danger,
    border: `1px solid ${colorTokens.danger}`,
  };
}

export function inputStyle(): CSSProperties {
  return {
    inlineSize: '100%',
    maxInlineSize: '28rem',
    minBlockSize: '36px',
    paddingInline: spacingTokens.sm,
    paddingBlock: '6px',
    borderRadius: radiusTokens.md,
    border: `1px solid ${colorTokens.border}`,
    background: colorTokens.surface,
    color: colorTokens.textPrimary,
    fontFamily: 'inherit',
    fontSize: '0.875rem',
  };
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBlockEnd: spacingTokens.md }}>
      <label
        htmlFor={htmlFor}
        style={{ display: 'block', marginBlockEnd: '4px', fontSize: '0.8125rem', fontWeight: 600 }}
      >
        {label}
      </label>
      {children}
      {hint && (
        <p
          style={{
            margin: 0,
            marginBlockStart: '4px',
            fontSize: '0.75rem',
            color: colorTokens.textSecondary,
          }}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Status pill.
 *
 * Colour is never the only carrier: the status word itself is the label, so the
 * meaning survives greyscale and colour-blindness (WCAG 1.4.1).
 */
export function StatusPill({ status }: { status: string }) {
  const tone = statusTone(status);
  return (
    <span
      data-testid={`status-${status}`}
      style={{
        display: 'inline-block',
        paddingInline: spacingTokens.sm,
        paddingBlock: '2px',
        borderRadius: radiusTokens.full,
        fontSize: '0.75rem',
        fontWeight: 600,
        background: tone.background,
        color: tone.color,
        border: `1px solid ${tone.border}`,
      }}
    >
      {status}
    </span>
  );
}

function statusTone(status: string): { background: string; color: string; border: string } {
  switch (status) {
    case 'ACTIVE':
    case 'ACCEPTED':
      return {
        background: '#ECFDF3',
        color: colorTokens.success,
        border: colorTokens.success,
      };
    case 'SUSPENDED':
    case 'REVOKED':
    case 'EXPIRED':
      return { background: '#FEF3F2', color: colorTokens.danger, border: colorTokens.danger };
    case 'TRIALING':
    case 'PENDING':
    case 'PAST_DUE':
      return { background: '#FFFAEB', color: colorTokens.warning, border: colorTokens.warning };
    default:
      return {
        background: colorTokens.surfaceMuted,
        color: colorTokens.textSecondary,
        border: colorTokens.border,
      };
  }
}

/** A table that scrolls inside its own box rather than the page. */
export function TableScroll({ children }: { children: ReactNode }) {
  return <div style={scrollContainerStyle()}>{children}</div>;
}

export function tableStyle(): CSSProperties {
  return {
    inlineSize: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.875rem',
    // `text-align: start` rather than `left`, so Arabic mirrors correctly.
    textAlign: 'start',
  };
}

export function thStyle(): CSSProperties {
  return {
    textAlign: 'start',
    padding: spacingTokens.sm,
    borderBlockEnd: `1px solid ${colorTokens.border}`,
    color: colorTokens.textSecondary,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
}

export function tdStyle(): CSSProperties {
  return {
    padding: spacingTokens.sm,
    borderBlockEnd: `1px solid ${colorTokens.cardBorder}`,
    verticalAlign: 'top',
  };
}

/** An honest empty state. Never a fabricated number. */
export function EmptyState({ message }: { message: string }) {
  return (
    <p
      data-testid="empty-state"
      style={{
        margin: 0,
        padding: spacingTokens.md,
        color: colorTokens.textSecondary,
        fontSize: '0.875rem',
        background: colorTokens.appBackground,
        borderRadius: radiusTokens.md,
      }}
    >
      {message}
    </p>
  );
}

/** Inline status banner for the `?ok=` / `?error=` codes. */
export function Banner({ tone, children }: { tone: 'success' | 'error'; children: ReactNode }) {
  const success = tone === 'success';
  return (
    <p
      role="status"
      data-testid={success ? 'success-banner' : 'error-banner'}
      style={{
        margin: 0,
        marginBlockEnd: spacingTokens.md,
        padding: spacingTokens.sm,
        borderRadius: radiusTokens.md,
        fontSize: '0.875rem',
        background: success ? '#ECFDF3' : '#FEF3F2',
        color: success ? colorTokens.success : colorTokens.danger,
        borderInlineStart: `3px solid ${success ? colorTokens.success : colorTokens.danger}`,
      }}
    >
      {children}
    </p>
  );
}
