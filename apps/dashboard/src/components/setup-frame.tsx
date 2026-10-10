import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandGlyph, LanguageSwitcher, visuallyHiddenStyle } from '@brandspace/ui';
import { translator } from '../i18n/messages';
import { requestMessageLocale } from '../server/message-locale';

/**
 * THE SETUP CARD, ON ITS OWN PAGE — `Auth.dc.html` lines 114–200 (review of #67).
 *
 * The prototype's onboarding is a standalone centred card on the auth wash,
 * with no app shell: the logo row with "STEP n OF 5" beside the wordmark, five
 * step bars (Business · Brand · Teach · Accounts · Goal), the step's 34px
 * heading and its line, the step, then its footer (Back · "Every step is
 * saved…" · Skip · Continue). Each page keeps its own forms and actions — this
 * is only where they are drawn.
 */

export interface SetupFrameStep {
  /** The product's own step key, kept as the test hook (`onboarding-step-<key>`). */
  readonly key: string;
  readonly label: string;
  readonly complete: boolean;
  readonly current: boolean;
  /** A step already reachable is a link back to it; the others are text. */
  readonly href: string | null;
}

export function SetupFrame({
  locale,
  languageHref,
  stepsLabel,
  doneLabel,
  steps,
  stepText,
  heading,
  description,
  testId,
  view,
  footer,
  children,
}: {
  readonly locale: string;
  /** Where the language button goes: the same page in the other language. */
  readonly languageHref: string;
  readonly stepsLabel: string;
  readonly doneLabel: string;
  readonly steps: readonly SetupFrameStep[];
  /** "Step 2 of 5" — the prototype's eyebrow beside the wordmark; none on Ready. */
  readonly stepText?: string | undefined;
  readonly heading: string;
  readonly description?: string | undefined;
  readonly testId: string;
  readonly view?: string | undefined;
  /** The step's footer row (`Auth.dc.html` line 196). */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  // The words this member reads (one Arabic for every country, round 4 Step 6).
  const words = requestMessageLocale(locale);
  const t = translator(words);
  const target = locale === 'ar' ? 'en' : 'ar';
  /*
   * THE BARS ARE THE PROTOTYPE'S, BY POSITION (round 3): the steps before the
   * one on screen are green, it is purple, the ones after are grey — on Ready
   * all five are green. Whether a step's data exists is still said to a
   * screen reader ("— done") and kept as `data-complete`.
   */
  const at = steps.findIndex((step) => step.current);
  const position = at < 0 ? steps.length : at;
  return (
    <div className="bsp-auth">
      <main id="main" className="bsp-auth-stage">
        <div className="bsp-wz bsp-wz-solo" data-testid={testId} data-view={view}>
          <div className="bsp-wz-brand">
            <span className="bsp-auth-logo" data-testid="auth-brand-mark">
              <BrandGlyph size="var(--bsp-px-40)" />
            </span>
            {/* The product's name, in Latin in both languages, as the prototype writes it. */}
            <span className="bsp-auth-word bsp-ltr" lang="en">
              Brandspace
            </span>
            {stepText ? (
              <span className="bsp-wz-eyebrow" data-testid="setup-progress-text">
                {stepText}
              </span>
            ) : null}
            <nav
              aria-label={locale === 'ar' ? 'التنقل الرئيسي' : 'Main navigation'}
              className="bsp-auth-lang"
            >
              <LanguageSwitcher
                href={languageHref}
                targetLocale={target}
                targetLabel={target === 'ar' ? 'ع' : 'EN'}
                ariaLabel={t('topbar.switchLanguage')}
              />
            </nav>
          </div>
          <nav aria-label={stepsLabel} data-testid="setup-stepper">
            <ol className="bsp-wz-steps">
              {steps.map((step, index) => {
                const body = (
                  <>
                    <span
                      aria-hidden="true"
                      className="bsp-wz-bar"
                      data-state={
                        index < position ? 'done' : index === position ? 'current' : 'todo'
                      }
                    />
                    <span className="bsp-wz-sl">{step.label}</span>
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
                    data-current={step.current ? 'true' : 'false'}
                    className="bsp-wz-step"
                  >
                    {step.href ? (
                      <Link
                        href={step.href}
                        aria-current={step.current ? 'step' : undefined}
                        className="bsp-wz-sbody"
                      >
                        {body}
                      </Link>
                    ) : (
                      <span
                        className="bsp-wz-sbody"
                        aria-current={step.current ? 'step' : undefined}
                      >
                        {body}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="bsp-wz-head">
            <h1 data-testid="heading">{heading}</h1>
            {description ? <p>{description}</p> : null}
          </div>
          {children}
          {footer ? (
            <div className="bsp-wz-foot" data-testid="setup-footer">
              {footer}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

/**
 * THE FOOTER ROW (`Auth.dc.html` line 196): Back (a ghost button) · the
 * "Every step is saved" line · Skip (ghost) · Continue (purple). Each control
 * is the step's own — a link to a step, or a submit button tied to the step's
 * form by `form=`.
 */
export function SetupFooter({
  back,
  note,
  skip,
  next,
}: {
  readonly back?: ReactNode;
  readonly note: string;
  readonly skip?: ReactNode;
  readonly next?: ReactNode;
}) {
  return (
    <>
      {back}
      <span className="bsp-wz-note">{note}</span>
      {skip}
      {next}
    </>
  );
}
