import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandGlyph, LanguageSwitcher, visuallyHiddenStyle } from '@brandspace/ui';
import { translator } from '../i18n/messages';

/**
 * THE SETUP CARD, ON ITS OWN PAGE — `Auth.dc.html` lines 114–200 (review of #67).
 *
 * The prototype's onboarding is a standalone centred card on the auth wash,
 * with no app shell: the logo row, five step bars (Business · Brand · Teach ·
 * Accounts · Goal), the step's 34px heading and its line, then the step. The
 * workspace form (/onboarding/workspace) is step 1, Business; the wizard
 * (/onboarding) is the other four. Each page keeps its own forms and actions —
 * this is only where they are drawn.
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
  heading,
  description,
  testId,
  view,
  children,
}: {
  readonly locale: string;
  /** Where the language button goes: the same page in the other language. */
  readonly languageHref: string;
  readonly stepsLabel: string;
  readonly doneLabel: string;
  readonly steps: readonly SetupFrameStep[];
  readonly heading: string;
  readonly description?: string | undefined;
  readonly testId: string;
  readonly view?: string | undefined;
  readonly children: ReactNode;
}) {
  const t = translator(locale);
  const target = locale === 'ar' ? 'en' : 'ar';
  return (
    <div className="bsp-auth">
      <main id="main" className="bsp-auth-stage">
        <div className="bsp-wz bsp-wz-solo" data-testid={testId} data-view={view}>
          <div className="bsp-wz-brand">
            <span className="bsp-auth-logo" data-testid="auth-brand-mark">
              <BrandGlyph size="40px" />
            </span>
            <span className="bsp-auth-word">{t('app.title')}</span>
            <nav
              aria-label={locale === 'ar' ? 'التنقل الرئيسي' : 'Main navigation'}
              className="bsp-auth-lang"
            >
              <LanguageSwitcher
                href={languageHref}
                targetLocale={target}
                targetLabel={target === 'ar' ? 'ع' : 'EN'}
                ariaLabel={locale === 'ar' ? 'تغيير اللغة' : 'Change language'}
              />
            </nav>
          </div>
          <nav aria-label={stepsLabel} data-testid="setup-stepper">
            <ol className="bsp-wz-steps">
              {steps.map((step) => {
                const body = (
                  <>
                    <span
                      aria-hidden="true"
                      className="bsp-wz-bar"
                      data-state={step.complete ? 'done' : step.current ? 'current' : 'todo'}
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
        </div>
      </main>
    </div>
  );
}
