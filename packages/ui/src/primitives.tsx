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

export type ButtonVariant = 'primary' | 'brand' | 'accent' | 'neutral' | 'ghost' | 'danger';
export type ControlSize = 'sm' | 'md' | 'lg';

/*
 * THE CONTROL HEIGHTS OF `prototype-2026-09-27` (review of #68, round 4, step 1).
 *
 * Measured from the prototype at runtime, not read off a screenshot: `.btn` is
 * 40px, `.btn.sm` 32px, the hero's large `.btn` 48px. They are the only three
 * button heights the prototype draws, and the only three the product may.
 */
const CONTROL_HEIGHT: Record<ControlSize, string> = {
  sm: 'var(--bsp-px-32)',
  md: 'var(--bsp-px-40)',
  lg: 'var(--bsp-px-48)',
};

/**
 * THE ONE BUTTON SYSTEM — the prototype's `.btn`, ported as `.bsp-btn` in
 * `prototype.css`, with its variants and sizes as classes.
 *
 * ROUND 4 RETIRED THE INLINE BUTTON STYLE. `buttonStyle()` painted the fill and
 * the geometry inline, from the retired full-demo reference (36px, 9px type),
 * and an inline fill beats every `:hover` rule — so a third of the product's
 * buttons were the wrong size and had no hover. Every button is now a class:
 * one geometry, one set of fills, the prototype's hover and disabled states.
 *
 *   primary → `.btn`            ink `#111114`, hover `#2a2a30`
 *   brand   → `.btn.pur`        purple `#7935fe`, hover `#6528e0`
 *   neutral → `.btn.sec`        `#f2f2f4`, hover `#e6e6ea`
 *   ghost   → `.btn.ghost`      transparent, hover `#f2f2f4`
 *   danger  → `.btn.sec` with the prototype's destructive red text `#b83245`
 *   accent  → `.btn.sec` (the prototype draws no yellow button)
 *
 * Use it on a plain `<button type="submit">` or a `<Link>` wherever `Button`
 * cannot be used (a no-JavaScript form, a navigation).
 */
export function buttonClass(variant: ButtonVariant = 'primary', size: ControlSize = 'md'): string {
  const fill: Record<ButtonVariant, string> = {
    primary: '',
    brand: ' bsp-pur',
    neutral: ' bsp-sec',
    ghost: ' bsp-ghost',
    danger: ' bsp-sec bsp-danger',
    accent: ' bsp-sec',
  };
  const scale = size === 'sm' ? ' bsp-sm' : size === 'lg' ? ' bsp-lg' : '';
  return `bsp-btn${fill[variant]}${scale}`;
}

/** The retired full-demo heights, for the Control Center's `buttonStyle` only. */
const LEGACY_CONTROL_HEIGHT: Record<ControlSize, string> = {
  sm: layoutTokens.controlHeightXs,
  md: layoutTokens.controlHeight,
  lg: 'var(--bsp-rem-3)',
};

function buttonBase(size: ControlSize): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacingTokens.sm,
    minBlockSize: LEGACY_CONTROL_HEIGHT[size],
    paddingInline: size === 'sm' ? 'var(--bsp-rem-0-6875)' : 'var(--bsp-rem-0-9375)',
    paddingBlock: 0,
    borderRadius: size === 'sm' ? radiusTokens.md : radiusTokens.control,
    fontFamily: 'inherit',
    fontSize: size === 'sm' ? 'var(--bsp-rem-0-5625)' : typographyTokens.button.fontSize,
    fontWeight: size === 'sm' ? 750 : typographyTokens.button.fontWeight,
    letterSpacing: 'normal',
    lineHeight: typographyTokens.button.lineHeight,
    cursor: 'pointer',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    border: '1px solid transparent',
    transition: `background-color ${motionTokens.fast} ${motionTokens.easeOut}`,
  };
}

/**
 * CONTROL CENTER ONLY — the inline button style of the retired full-demo
 * reference, kept for `apps/admin`, which is not a customer screen and keeps
 * its own look. Customer code uses `buttonClass()`/`Button`; a unit test
 * (`tests/unit/r4-shared-controls.test.ts`) refuses `buttonStyle` anywhere in
 * `apps/dashboard` or in the customer components of this package.
 */
export function buttonStyle(
  variant: ButtonVariant = 'primary',
  size: ControlSize = 'md',
): CSSProperties {
  const base = buttonBase(size);
  switch (variant) {
    case 'primary':
      // Ink on white text at 18.85:1 — the highest-contrast action in the
      // system, which is the right place for the most important one.
      return { ...base, background: colorTokens.ink, color: colorTokens.inkInk };
    case 'brand':
      // `.primary-button { background: var(--purple); color: #fff }`. The full
      // demo gives it NO glow — the flat purple is the whole treatment.
      return {
        ...base,
        background: colorTokens.brandPurple,
        color: colorTokens.brandPurpleInk,
      };
    case 'accent':
      // Yellow with near-black ink at 15.3:1. Never white text on yellow.
      return { ...base, background: colorTokens.brandYellow, color: colorTokens.brandYellowInk };
    case 'neutral':
      // `.soft-button { background: var(--soft) }`.
      return {
        ...base,
        background: colorTokens.surfaceMuted,
        color: colorTokens.textPrimary,
      };
    case 'ghost':
      return { ...base, background: 'transparent', color: colorTokens.textSecondary };
    case 'danger':
      return { ...base, background: colorTokens.dangerTint, color: colorTokens.danger };
  }
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
  const extra: CSSProperties = {
    ...(fullWidth ? { inlineSize: '100%' } : {}),
    ...(loading ? { opacity: 0.75 } : {}),
    ...style,
  };
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled === true || loading}
      aria-busy={loading || undefined}
      className={[buttonClass(variant, size), className].filter(Boolean).join(' ')}
      {...(Object.keys(extra).length > 0 ? { style: extra } : {})}
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
        // D-484: the size token, so the customer app draws it at 0.88.
        inlineSize: `var(--bsp-px-${size}, ${size}px)`,
        blockSize: `var(--bsp-px-${size}, ${size}px)`,
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
      className={[buttonClass(variant, size), className].filter(Boolean).join(' ')}
      style={{
        inlineSize: edge,
        blockSize: edge,
        paddingInline: 0,
        ...(circular ? { borderRadius: radiusTokens.full } : {}),
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
  const { tone = 'default' } = options;
  const toneBorder =
    tone === 'error' ? colorTokens.danger : tone === 'success' ? colorTokens.success : undefined;
  // The prototype's form field (round 4): `9px 12px`, radius 12, 14px, and no
  // stated height — its padding and one line, as measured; a select is the
  // dropdown trigger's 40px (`prototype.css`). The fill and the `#e4e4e8`
  // border come from `.bs-control` in `prototype.css`. `size` no longer
  // shrinks a field.
  return {
    inlineSize: '100%',
    boxSizing: 'border-box',
    paddingInline: 'var(--bsp-px-12)',
    paddingBlock: 'var(--bsp-px-9)',
    borderRadius: 'var(--bsp-px-12)',
    ...(toneBorder ? { border: `1px solid ${toneBorder}` } : {}),
    color: colorTokens.textPrimary,
    fontFamily: 'inherit',
    fontSize: 'var(--bsp-fs-14)',
    lineHeight: 'normal',
  };
}

/** The class every input, select and textarea must carry. */
export const CONTROL_CLASS = 'bs-control';

export function textareaStyle(options: { tone?: ControlTone } = {}): CSSProperties {
  return {
    ...inputStyle(options),
    minBlockSize: 'var(--bsp-rem-7)',
    resize: 'vertical',
    paddingBlock: 'var(--bsp-px-10)',
    lineHeight: 1.5,
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
    /* `.field { margin-bottom: 16px }`. */
    <div style={{ marginBlockEnd: spacingTokens.md }}>
      <label
        htmlFor={htmlFor}
        /*
          `.field label { display: block; margin-bottom: 7px; font-size: 9px;
           font-weight: 800 }` — the demo's form labels are SMALL AND HEAVY, a
          step below body copy, not a 12px semibold line. At `label` (12px/700)
          they read as headings and every form was a stack of headings.
        */
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: spacingTokens['3xs'],
          marginBlockEnd: 'var(--bsp-rem-0-4375)',
          ...typographyTokens.caption,
          fontWeight: 800,
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
  const edge =
    size === 'sm' ? 'var(--bsp-rem-2)' : size === 'lg' ? 'var(--bsp-rem-3)' : 'var(--bsp-rem-2-5)';
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
