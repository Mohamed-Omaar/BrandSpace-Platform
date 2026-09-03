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
 * THE 2C-A REVISION REMOVED THE OUTLINES (D-55). A control used to be a white
 * box with a grey stroke; it is now a soft filled shape with a transparent
 * resting border, a 12px radius and a 44px height. The stroke returns only
 * where it carries meaning — an error, or a reader whose OS asks for more
 * contrast (`tokens.css`, `prefers-contrast: more`).
 *
 * Identification without a stroke rests on three things, and all three are
 * obligations rather than preferences:
 *
 *   1. a PERSISTENT visible label — `Field` renders one and there is no
 *      placeholder-only path through this API;
 *   2. a fill that differs from the surface it sits on;
 *   3. a 2px purple focus ring at 5.6:1.
 *
 * `bs-control` and `bs-pressable` come from `tokens.css`, because hover, active
 * and disabled are pseudo-classes and an inline style cannot express them. A
 * filled control with no hover feedback feels broken.
 */

export type ButtonVariant = 'primary' | 'accent' | 'neutral' | 'ghost' | 'danger';
export type ControlSize = 'sm' | 'md' | 'lg';

const CONTROL_HEIGHT: Record<ControlSize, string> = {
  sm: layoutTokens.controlHeightSm,
  md: layoutTokens.controlHeight,
  lg: '3rem',
};

function buttonBase(size: ControlSize): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacingTokens.sm,
    minBlockSize: CONTROL_HEIGHT[size],
    paddingInline: size === 'sm' ? spacingTokens.md : spacingTokens.lg,
    paddingBlock: spacingTokens.xs,
    borderRadius: radiusTokens.md,
    fontFamily: 'inherit',
    fontSize: size === 'sm' ? typographyTokens.caption.fontSize : typographyTokens.bodySm.fontSize,
    fontWeight: 600,
    lineHeight: typographyTokens.bodySm.lineHeight,
    cursor: 'pointer',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    border: '1px solid transparent',
    transition: `background-color ${motionTokens.fast} ${motionTokens.easeOut}`,
  };
}

/**
 * Button styling by variant.
 *
 * FIVE VARIANTS, ONE RULE: none of them is a stroked box. Primary is a solid
 * purple surface; accent is the yellow, which carries near-black text and is
 * used sparingly; neutral is a soft lavender-grey fill; ghost has no resting
 * surface at all; destructive is a soft red fill rather than a red outline —
 * a red-outlined button beside a filled purple one reads as equally routine,
 * and these are the actions CLAUDE.md §2.5 calls high-impact.
 */
export function buttonStyle(
  variant: ButtonVariant = 'primary',
  size: ControlSize = 'md',
): CSSProperties {
  const base = buttonBase(size);
  switch (variant) {
    case 'primary':
      return { ...base, background: colorTokens.brandPurple, color: colorTokens.brandPurpleInk };
    case 'accent':
      // Yellow with near-black ink at 15.3:1. Never white text on yellow.
      return { ...base, background: colorTokens.brandYellow, color: colorTokens.brandYellowInk };
    case 'neutral':
      return {
        ...base,
        background: colorTokens.controlSurface,
        color: colorTokens.textPrimary,
      };
    case 'ghost':
      return { ...base, background: 'transparent', color: colorTokens.textSecondary };
    case 'danger':
      return { ...base, background: colorTokens.dangerTint, color: colorTokens.danger };
  }
}

/** The interaction classes a button needs for hover, active and disabled. */
function buttonClass(variant: ButtonVariant): string {
  return variant === 'neutral' || variant === 'ghost' ? 'bs-pressable bs-control' : 'bs-pressable';
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  iconEnd,
  fullWidth = false,
  loading = false,
  loadingLabel,
  children,
  style,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ButtonVariant;
  readonly size?: ControlSize;
  readonly icon?: ReactNode;
  readonly iconEnd?: ReactNode;
  readonly fullWidth?: boolean;
  /** Disables the control AND announces the wait. Never one without the other. */
  readonly loading?: boolean;
  readonly loadingLabel?: string | undefined;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled === true || loading}
      aria-busy={loading || undefined}
      className={[buttonClass(variant), className].filter(Boolean).join(' ')}
      style={{
        ...buttonStyle(variant, size),
        ...(fullWidth ? { inlineSize: '100%' } : {}),
        ...(loading ? { opacity: 0.75 } : {}),
        ...style,
      }}
    >
      {loading ? <Spinner /> : icon}
      {loading && loadingLabel ? loadingLabel : children}
      {!loading && iconEnd ? iconEnd : null}
    </button>
  );
}

/** A pure-CSS spinner. `aria-hidden` — the button's `aria-busy` is the signal. */
export function Spinner({ size = 16 }: { readonly size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="bs-spinner"
      style={{
        display: 'inline-block',
        inlineSize: size,
        blockSize: size,
        borderRadius: radiusTokens.full,
        border: '2px solid currentColor',
        borderBlockStartColor: 'transparent',
        opacity: 0.8,
      }}
    />
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
  variant = 'ghost',
  size = 'md',
  circular = false,
  style,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  readonly label: string;
  readonly icon: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ControlSize;
  readonly circular?: boolean;
}) {
  const edge = CONTROL_HEIGHT[size];
  return (
    <button
      type="button"
      aria-label={label}
      {...rest}
      className={[buttonClass(variant), className].filter(Boolean).join(' ')}
      style={{
        ...buttonStyle(variant, size),
        inlineSize: edge,
        blockSize: edge,
        minInlineSize: layoutTokens.minTargetSize,
        paddingInline: 0,
        borderRadius: circular ? radiusTokens.full : radiusTokens.md,
        ...style,
      }}
    >
      {icon}
    </button>
  );
}

export type ControlTone = 'default' | 'error' | 'success';

/**
 * Input, select and textarea styling.
 *
 * The resting border is TRANSPARENT and the fill does the identifying. An
 * error or success state is the one place a control keeps a real 3:1 boundary,
 * because there the edge carries meaning rather than decoration — and it is
 * never the only signal: `Field` also renders an icon and a sentence.
 */
export function inputStyle(
  options: { tone?: ControlTone; size?: ControlSize } = {},
): CSSProperties {
  const { tone = 'default', size = 'md' } = options;
  const toneBorder =
    tone === 'error' ? colorTokens.danger : tone === 'success' ? colorTokens.success : undefined;
  return {
    inlineSize: '100%',
    minBlockSize: CONTROL_HEIGHT[size],
    paddingInline: spacingTokens.md,
    paddingBlock: spacingTokens.sm,
    borderRadius: radiusTokens.md,
    // `bs-control` supplies the fill and the transparent resting border; a tone
    // overrides only the colour, so high-contrast mode still wins on default.
    ...(toneBorder ? { border: `1px solid ${toneBorder}` } : {}),
    color: colorTokens.textPrimary,
    fontFamily: 'inherit',
    fontSize: typographyTokens.bodySm.fontSize,
    lineHeight: typographyTokens.bodySm.lineHeight,
  };
}

/** The class every input, select and textarea must carry. */
export const CONTROL_CLASS = 'bs-control';

export function textareaStyle(options: { tone?: ControlTone } = {}): CSSProperties {
  return {
    ...inputStyle(options),
    minBlockSize: '7rem',
    resize: 'vertical',
    paddingBlock: spacingTokens.sm,
    lineHeight: typographyTokens.body.lineHeight,
  };
}

/**
 * A labelled form control.
 *
 * The label is a real `<label for>` and is ALWAYS rendered — there is no
 * placeholder-only path through this API, because a placeholder disappears the
 * moment someone types and takes the control's only identification with it.
 * That matters more than usual here: with the resting border gone, the label is
 * load-bearing (D-55).
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  success,
  required = false,
  optionalLabel,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly success?: string | undefined;
  readonly required?: boolean;
  /** Shown when NOT required, so "optional" is stated rather than inferred. */
  readonly optionalLabel?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div style={{ marginBlockEnd: spacingTokens.lg }}>
      <label
        htmlFor={htmlFor}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: spacingTokens.xs,
          marginBlockEnd: spacingTokens.xs,
          ...typographyTokens.label,
          color: colorTokens.textPrimary,
        }}
      >
        {label}
        {required ? (
          <span aria-hidden="true" style={{ color: colorTokens.danger }}>
            *
          </span>
        ) : optionalLabel ? (
          <span
            style={{ ...typographyTokens.caption, color: colorTokens.textMuted, fontWeight: 400 }}
          >
            {optionalLabel}
          </span>
        ) : null}
      </label>
      {children}
      {hint && !error ? (
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
            display: 'flex',
            alignItems: 'center',
            gap: spacingTokens.xs,
            margin: 0,
            marginBlockStart: spacingTokens.xs,
            ...typographyTokens.caption,
            color: colorTokens.danger,
            fontWeight: 600,
          }}
        >
          <span aria-hidden="true">⚠</span>
          {error}
        </p>
      ) : null}
      {success && !error ? (
        <p
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: spacingTokens.xs,
            margin: 0,
            marginBlockStart: spacingTokens.xs,
            ...typographyTokens.caption,
            color: colorTokens.success,
            fontWeight: 600,
          }}
        >
          <span aria-hidden="true">✓</span>
          {success}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A group of related fields.
 *
 * Grouping by HEADING AND SPACING on a soft surface, rather than by drawing a
 * box around every group — which is the thing that made the old forms read as
 * nested outlined rectangles.
 */
export function FieldGroup({
  title,
  description,
  children,
  tinted = false,
}: {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly children: ReactNode;
  /** Puts the group on a warm surface. For one group among several, not all. */
  readonly tinted?: boolean;
}) {
  return (
    <section
      style={{
        marginBlockEnd: spacingTokens.xl,
        ...(tinted
          ? {
              background: colorTokens.surfaceWarm,
              borderRadius: radiusTokens.xl,
              padding: spacingTokens.lg,
            }
          : {}),
      }}
    >
      {title ? (
        <h3
          style={{
            ...typographyTokens.h3,
            color: colorTokens.textPrimary,
            marginBlockEnd: description ? spacingTokens['3xs'] : spacingTokens.md,
          }}
        >
          {title}
        </h3>
      ) : null}
      {description ? (
        <p
          style={{
            margin: 0,
            marginBlockEnd: spacingTokens.md,
            ...typographyTokens.bodySm,
            color: colorTokens.textSecondary,
          }}
        >
          {description}
        </p>
      ) : null}
      {children}
    </section>
  );
}

/** A hairline divider that separates without outlining. */
export function Divider({ spacing = spacingTokens.lg }: { readonly spacing?: string }) {
  return (
    <hr
      style={{
        border: 0,
        borderBlockStart: `1px solid ${colorTokens.hairline}`,
        marginBlock: spacing,
      }}
    />
  );
}

/** A row of actions that wraps rather than overflowing on a narrow screen. */
export function ButtonRow({
  children,
  align = 'start',
  gap = spacingTokens.sm,
}: {
  readonly children: ReactNode;
  readonly align?: 'start' | 'end';
  readonly gap?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap,
        alignItems: 'center',
        justifyContent: align === 'end' ? 'flex-end' : 'flex-start',
      }}
    >
      {children}
    </div>
  );
}

/**
 * An icon in a soft rounded tile.
 *
 * The tile is what lets an icon carry weight in a borderless system: it gives
 * the glyph a surface of its own so a card has a focal point without a stroke.
 */
export function IconTile({
  icon,
  tone = 'brand',
  size = 'md',
}: {
  readonly icon: ReactNode;
  readonly tone?: 'brand' | 'accent' | 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  readonly size?: 'sm' | 'md' | 'lg';
}) {
  const edge = size === 'sm' ? '2rem' : size === 'lg' ? '3rem' : '2.5rem';
  const palette = {
    brand: { background: colorTokens.surfaceLavenderStrong, color: colorTokens.brandPurplePressed },
    accent: { background: colorTokens.brandYellowTint, color: colorTokens.brandYellowText },
    neutral: { background: colorTokens.surfaceMuted, color: colorTokens.textSecondary },
    success: { background: colorTokens.successTint, color: colorTokens.success },
    warning: { background: colorTokens.warningTint, color: colorTokens.warning },
    danger: { background: colorTokens.dangerTint, color: colorTokens.danger },
    info: { background: colorTokens.infoTint, color: colorTokens.info },
  }[tone];

  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        inlineSize: edge,
        blockSize: edge,
        flexShrink: 0,
        borderRadius: size === 'sm' ? radiusTokens.sm : radiusTokens.md,
        ...palette,
      }}
    >
      {icon}
    </span>
  );
}
