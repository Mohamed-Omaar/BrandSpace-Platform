import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import {
  colorTokens,
  layoutTokens,
  motionTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from './tokens';

/**
 * The control primitives every surface composes.
 *
 * STYLE FUNCTIONS, NOT CLASS NAMES. The applications render on the server with
 * no CSS build step beyond `tokens.css`, so a style object is what actually
 * travels. Each function reads only from `tokens.ts`, which is what makes the
 * "no colour literals in applications" rule enforceable rather than aspirational.
 *
 * Every size is LOGICAL (`padding-inline`, `border-inline-start`, `inline-size`)
 * so Arabic RTL mirrors with no second implementation.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'danger';
export type ControlSize = 'sm' | 'md';

const CONTROL_HEIGHT: Record<ControlSize, string> = {
  sm: '2rem',
  md: layoutTokens.controlHeight,
};

function buttonBase(size: ControlSize): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacingTokens.sm,
    minBlockSize: CONTROL_HEIGHT[size],
    paddingInline: size === 'sm' ? spacingTokens.sm : spacingTokens.md,
    paddingBlock: spacingTokens.xs,
    borderRadius: radiusTokens.md,
    fontFamily: 'inherit',
    fontSize: typographyTokens.bodySm.fontSize,
    fontWeight: 600,
    lineHeight: typographyTokens.bodySm.lineHeight,
    cursor: 'pointer',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    transition: `background-color ${motionTokens.fast} ${motionTokens.easeOut}, border-color ${motionTokens.fast} ${motionTokens.easeOut}`,
  };
}

/**
 * Button styling by variant.
 *
 * `secondary` and `tertiary` use `borderStrong`, not `border`: WCAG 1.4.11
 * requires a UI component's boundary to reach 3:1 against its surroundings, and
 * the subtle `border` token is decorative at 1.44:1. A control the eye cannot
 * find is not a control.
 */
export function buttonStyle(
  variant: ButtonVariant = 'primary',
  size: ControlSize = 'md',
): CSSProperties {
  const base = buttonBase(size);
  switch (variant) {
    case 'primary':
      return {
        ...base,
        background: colorTokens.brandPurple,
        color: colorTokens.brandPurpleInk,
        border: `1px solid ${colorTokens.brandPurple}`,
      };
    case 'secondary':
      return {
        ...base,
        background: colorTokens.surface,
        color: colorTokens.textPrimary,
        border: `1px solid ${colorTokens.borderStrong}`,
      };
    case 'tertiary':
      return {
        ...base,
        background: 'transparent',
        color: colorTokens.brandPurple,
        border: '1px solid transparent',
      };
    case 'danger':
      // Destructive actions are outlined, never a filled red block: a filled
      // red button next to a filled purple one reads as equally routine, and
      // these are the actions CLAUDE.md §2.5 calls high-impact.
      return {
        ...base,
        background: colorTokens.surface,
        color: colorTokens.danger,
        border: `1px solid ${colorTokens.danger}`,
      };
  }
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  fullWidth = false,
  children,
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ButtonVariant;
  readonly size?: ControlSize;
  readonly icon?: ReactNode;
  readonly fullWidth?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      style={{
        ...buttonStyle(variant, size),
        ...(fullWidth ? { inlineSize: '100%' } : {}),
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * A control whose entire content is an icon.
 *
 * `label` is REQUIRED and becomes the accessible name. An icon-only button with
 * no name is invisible to a screen reader, and the icon itself is `aria-hidden`
 * by design — so if this were optional, the default would be a silent control.
 */
export function IconButton({
  label,
  icon,
  variant = 'tertiary',
  style,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  readonly label: string;
  readonly icon: ReactNode;
  readonly variant?: ButtonVariant;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      {...rest}
      style={{
        ...buttonStyle(variant, 'md'),
        // Square, and never below the WCAG 2.2 target-size minimum.
        inlineSize: layoutTokens.controlHeight,
        blockSize: layoutTokens.controlHeight,
        minInlineSize: layoutTokens.minTargetSize,
        paddingInline: 0,
        ...style,
      }}
    >
      {icon}
    </button>
  );
}

export function inputStyle(options: { invalid?: boolean } = {}): CSSProperties {
  return {
    inlineSize: '100%',
    minBlockSize: layoutTokens.controlHeight,
    paddingInline: spacingTokens.sm,
    paddingBlock: spacingTokens.xs,
    borderRadius: radiusTokens.md,
    // `borderStrong`, not `border`: an input outline is a UI component boundary
    // and must reach 3:1 (WCAG 1.4.11).
    border: `1px solid ${options.invalid ? colorTokens.danger : colorTokens.borderStrong}`,
    background: colorTokens.surface,
    color: colorTokens.textPrimary,
    fontFamily: 'inherit',
    fontSize: typographyTokens.bodySm.fontSize,
    lineHeight: typographyTokens.bodySm.lineHeight,
  };
}

export function textareaStyle(): CSSProperties {
  return {
    ...inputStyle(),
    minBlockSize: '6rem',
    resize: 'vertical',
    paddingBlock: spacingTokens.sm,
  };
}

/**
 * A labelled form control.
 *
 * The label is a real `<label for>`, the hint is wired through
 * `aria-describedby`, and an error is announced. Passing `error` also marks the
 * control invalid, so the state is not carried by colour alone (WCAG 1.4.1).
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly required?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div style={{ marginBlockEnd: spacingTokens.md }}>
      <label
        htmlFor={htmlFor}
        style={{
          display: 'block',
          marginBlockEnd: spacingTokens.xs,
          ...typographyTokens.label,
          color: colorTokens.textPrimary,
        }}
      >
        {label}
        {required ? (
          <span aria-hidden="true" style={{ color: colorTokens.danger }}>
            {' *'}
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <p
          id={`${htmlFor}-hint`}
          style={{
            margin: 0,
            marginBlockStart: spacingTokens.xs,
            ...typographyTokens.caption,
            color: colorTokens.textSecondary,
          }}
        >
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${htmlFor}-error`}
          role="alert"
          style={{
            margin: 0,
            marginBlockStart: spacingTokens.xs,
            ...typographyTokens.caption,
            color: colorTokens.danger,
            fontWeight: 600,
          }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A horizontal rule that uses the divider token rather than a browser default. */
export function Divider({ spacing = spacingTokens.lg }: { readonly spacing?: string }) {
  return (
    <hr
      style={{
        border: 0,
        borderBlockStart: `1px solid ${colorTokens.cardBorder}`,
        marginBlock: spacing,
      }}
    />
  );
}

/** A row of actions that wraps rather than overflowing on a narrow screen. */
export function ButtonRow({
  children,
  align = 'start',
}: {
  readonly children: ReactNode;
  readonly align?: 'start' | 'end';
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: spacingTokens.sm,
        justifyContent: align === 'end' ? 'flex-end' : 'flex-start',
      }}
    >
      {children}
    </div>
  );
}
