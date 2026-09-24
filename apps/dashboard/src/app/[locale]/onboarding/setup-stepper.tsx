import Link from 'next/link';
import {
  CheckIcon,
  colorTokens,
  motionTokens,
  radiusTokens,
  shadowTokens,
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
  return (
    <nav aria-label={label} data-testid="setup-stepper">
      <ol
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: spacingTokens['3xs'],
          margin: 0,
          padding: spacingTokens['3xs'],
          listStyle: 'none',
          borderRadius: radiusTokens.lg,
          background: colorTokens.surfaceMuted,
          maxInlineSize: '100%',
          inlineSize: 'fit-content',
        }}
      >
        {steps.map((step, index) => {
          const current = step.key === view;
          const linkable = step.key !== 'workspace' && (step.key === 'brand' || hasBrand);
          const body = (
            <>
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-grid',
                  placeItems: 'center',
                  inlineSize: '1.25rem',
                  blockSize: '1.25rem',
                  borderRadius: radiusTokens.full,
                  ...typographyTokens.caption,
                  fontWeight: 700,
                  background: step.complete
                    ? colorTokens.successTint
                    : current
                      ? colorTokens.surfaceLavenderStrong
                      : colorTokens.surfaceSunken,
                  color: step.complete
                    ? colorTokens.success
                    : current
                      ? colorTokens.brandPurplePressed
                      : colorTokens.textSecondary,
                }}
              >
                {step.complete ? <CheckIcon size={12} /> : index + 1}
              </span>
              <span>{stepLabel(step.key)}</span>
              {step.complete ? (
                <span style={visuallyHiddenStyle()}>{` — ${doneLabel}`}</span>
              ) : null}
            </>
          );
          const style = {
            display: 'inline-flex',
            alignItems: 'center',
            gap: spacingTokens.xs,
            minBlockSize: '2.25rem',
            paddingInline: spacingTokens.md,
            borderRadius: radiusTokens.md,
            ...typographyTokens.bodySm,
            fontWeight: 600,
            textDecoration: 'none',
            background: current ? colorTokens.surface : 'transparent',
            color: current ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
            boxShadow: current ? shadowTokens.card : 'none',
            transition: `color ${motionTokens.fast} ${motionTokens.easeOut}`,
          } as const;
          return (
            <li
              key={step.key}
              data-testid={`onboarding-step-${step.key}`}
              data-complete={step.complete ? 'true' : 'false'}
              data-current={current ? 'true' : 'false'}
            >
              {linkable ? (
                <Link
                  href={href(step.key as SetupView)}
                  aria-current={current ? 'step' : undefined}
                  className="bs-pressable"
                  style={style}
                >
                  {body}
                </Link>
              ) : (
                <span style={style}>{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
