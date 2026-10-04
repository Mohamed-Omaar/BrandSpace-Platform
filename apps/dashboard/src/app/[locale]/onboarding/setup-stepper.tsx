import Link from 'next/link';
import {
  colorTokens,
  motionTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  visuallyHiddenStyle,
} from '@brandspace/ui';
import type { SetupStepState, SetupView } from '../../../server/setup-wizard-state';

/**
 * THE SETUP WIZARD'S STEPPER — an APPROVED DESIGN-SYSTEM EXTENSION
 * (docs/UI-FIDELITY-CONTRACT.md §6, CLAUDE.md §4.2).
 *
 * No approved reference has a first-run stepper, so it is composed from what
 * already ships: the `LinkTabs` track and pill (muted track, raised white pill
 * with the pressed-purple label for the current step), the success tone for a
 * done step, the caption type scale. No new colour, radius or motion.
 *
 * AN ORDERED LIST OF LINKS, with `aria-current="step"` on the current one —
 * the WAI pattern for a progress indicator. Completion is stated in WORDS in
 * each step's text (visually hidden beside the tick), never by the tick alone (WCAG 1.4.1).
 *
 * The workspace step is done by construction and is not a link; nothing past
 * the brand step is a link until there is a brand, because every later step is
 * about one.
 */
export function SetupStepper({
  label,
  steps,
  view,
  hasBrand,
  href,
  stepLabel,
  doneLabel,
}: {
  readonly label: string;
  readonly steps: readonly SetupStepState[];
  readonly view: SetupView;
  readonly hasBrand: boolean;
  readonly href: (view: SetupView) => string;
  readonly stepLabel: (key: SetupStepState['key']) => string;
  readonly doneLabel: string;
}) {
  /*
   * D-468 — THE PROTOTYPE'S STEP BARS, `Auth.dc.html` line 117: one column per
   * step (`gap: 6px`), a 5px bar — green once done, purple for the current
   * step, `#ececef` ahead — over the step's name at 11.5px / 800, ink for the
   * current one. Done is also said in words, never by the colour alone.
   */
  return (
    <nav aria-label={label} data-testid="setup-stepper">
      <ol className="bsp-wz-steps">
        {steps.map((step) => {
          const current = step.key === view;
          const linkable = step.key !== 'workspace' && (step.key === 'brand' || hasBrand);
          const body = (
            <>
              <span
                aria-hidden="true"
                className="bsp-wz-bar"
                data-state={step.complete ? 'done' : current ? 'current' : 'todo'}
              />
              <span className="bsp-wz-sl">{stepLabel(step.key)}</span>
              {step.complete ? (
                <span style={visuallyHiddenStyle()}>{` — ${doneLabel}`}</span>
              ) : null}
            </>
          );
          return (
            <li
              key={step.key}
              data-testid={`onboarding-step-${step.key}`}
              data-complete={step.complete ? 'true' : 'false'}
              data-current={current ? 'true' : 'false'}
              className="bsp-wz-step"
            >
              {linkable ? (
                <Link
                  href={href(step.key as SetupView)}
                  aria-current={current ? 'step' : undefined}
                  className="bsp-wz-sbody"
                >
                  {body}
                </Link>
              ) : (
                <span className="bsp-wz-sbody">{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

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
