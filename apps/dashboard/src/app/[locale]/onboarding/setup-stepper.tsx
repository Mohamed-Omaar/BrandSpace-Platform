import Link from 'next/link';
import {
  colorTokens,
  motionTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  visuallyHiddenStyle,
} from '@brandspace/ui';

/**
 * WHERE THE READER IS IN THE JOURNEY (Phase 6 final acceptance, D-303).
 *
 * "Step 2 of 5 · Teach BrandSpace" in words, and a bar that fills with it —
 * the stepper above says which steps exist and which are done; this says,
 * at a glance, that it is a sequence and how far along it the reader is. The
 * bar is the `LinkTabs` track (surface-muted) with a brand-purple fill; the
 * position is also in the text and in the progressbar's value, never colour
 * alone. An APPROVED DESIGN-SYSTEM EXTENSION composed from existing tokens.
 */
export function SetupProgress({
  label,
  position,
  total,
  text,
  exit,
}: {
  readonly label: string;
  readonly position: number;
  readonly total: number;
  readonly text: string;
  readonly exit: { readonly href: string; readonly label: string };
}) {
  const percent = total > 0 ? Math.round((position / total) * 100) : 0;
  return (
    <div data-testid="setup-progress" style={{ display: 'grid', gap: spacingTokens.xs }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: spacingTokens.sm,
        }}
      >
        <p
          data-testid="setup-progress-text"
          style={{ margin: 0, ...typographyTokens.label, color: colorTokens.textPrimary }}
        >
          {text}
        </p>
        <Link
          href={exit.href}
          data-testid="setup-exit"
          style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
        >
          {exit.label}
        </Link>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={position}
        aria-valuetext={text}
        // D-468: the step bars above draw the position; the progressbar stays
        // for assistive technology.
        style={visuallyHiddenStyle()}
      >
        <div
          style={{
            blockSize: '100%',
            inlineSize: `${percent}%`,
            borderRadius: radiusTokens.full,
            background: colorTokens.brandPurple,
            transition: `inline-size ${motionTokens.base} ${motionTokens.easeOut}`,
          }}
        />
      </div>
    </div>
  );
}
