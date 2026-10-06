import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  Banner,
  Field,
  PasswordField,
  colorTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { getPrisma, withoutTenantContext } from '@brandspace/database';
import { TenantOnboardingPolicySource } from '@brandspace/onboarding';
import {
  customerLandingPath,
  currentEnvironment,
  getCustomer,
  getSessionToken,
} from '../../../../server/customer-context';
import { statusMessage, translator } from '../../../../i18n/messages';
import { AuthCard, authButtonStyle, authInputStyle } from '../../../../components/auth-card';
import { signUpAction } from '../actions';
import { BrowserTimeZoneInput } from '../../../../components/browser-time-zone';
import { trialTerms } from '../../../../server/trial-terms';
import { SIGNUP_DRAFT_COOKIE, decodeSignupDraft } from '../../../../server/signup-draft';

export const dynamic = 'force-dynamic';

/**
 * Self-service signup.
 *
 * THE FORM STATES THE RULES IT IS ENFORCING, and reads every one of them from
 * the activated `onboarding` document: whether signup is open at all, the
 * password floor, and which legal documents must be accepted at which version.
 * A minimum restated as a constant here would be a minimum the owner cannot
 * actually change (CLAUDE.md §2.2).
 *
 * THE TIMEZONE IS THE BROWSER'S (Round 4, 4.1 — the owner's decision). It is
 * no longer a question here: the browser's own zone is posted, onboarding step
 * 1 shows it and lets the person change it, and an empty value is still
 * refused rather than defaulted (D-194: the server never invents one).
 *
 * ONE PASSWORD FIELD, with Show (4.1): no confirmation box on sign-up. The
 * reset form keeps its confirmation (D-261).
 */
export default async function SignUpPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = translator(locale);
  const query = await searchParams;

  const existing = await getCustomer().catch(() => null);
  if (existing) {
    const token = await getSessionToken();
    redirect(token ? await customerLandingPath(locale, token) : `/${locale}/workspaces`);
  }

  const policy = await withoutTenantContext(
    async (db) => new TenantOnboardingPolicySource(db, currentEnvironment()).load(),
    { prisma: getPrisma() },
  );

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  const required = policy.legalDocuments.filter((document) => document.required);
  const trial = await trialTerms().catch(() => null);
  // G8 (D-335): after a refusal, what was typed comes back — never the password.
  const draft = error ? decodeSignupDraft((await cookies()).get(SIGNUP_DRAFT_COOKIE)?.value) : null;

  if (!policy.signup.open) {
    return (
      <AuthCard locale={locale} heading={t('signUp.title')}>
        <p data-testid="signup-closed">{t('signUp.closed')}</p>
        <Link href={`/${locale}/sign-in`} style={{ color: colorTokens.brandPurple }}>
          {t('signUp.haveAccount')}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      locale={locale}
      eyebrow={t('auth.eyebrow.signUp')}
      heading={t('signUp.start')}
      description={t('signUp.startSub')}
      footer={
        <Link href={`/${locale}/sign-in`} style={{ color: colorTokens.brandPurple }}>
          {t('signUp.haveAccount')}
        </Link>
      }
    >
      {error ? (
        <div role="alert" data-testid="signup-error">
          <Banner tone="error">{statusMessage(error, locale, ref) ?? t('signUp.failed')}</Banner>
        </div>
      ) : null}

      <form action={signUpAction} data-testid="signup-form">
        <input type="hidden" name="locale" value={locale} />

        <Field label={t('signUp.name')} htmlFor="name" required>
          <input
            className="bs-control"
            id="name"
            name="name"
            required
            maxLength={120}
            defaultValue={draft?.name ?? ''}
            autoComplete="name"
            style={authInputStyle()}
          />
        </Field>

        <Field label={t('signUp.email')} htmlFor="email" required>
          <input
            className="bs-control"
            id="email"
            name="email"
            type="email"
            required
            defaultValue={draft?.email ?? ''}
            autoComplete="email"
            style={authInputStyle()}
          />
        </Field>

        {/*
          The shared control (P6-03a). This screen already read the configured
          minimum — it was the only one that did — so what it gains is the
          reveal toggle and a rules list that keeps answering as the customer
          types, instead of one hint sentence that states a number and goes
          quiet. Round 4 (4.1): no confirmation box — omitting its label omits it.
        */}
        <PasswordField
          id="password"
          labels={{
            label: t('signUp.password'),
            show: t('password.show'),
            hide: t('password.hide'),
            rulesLabel: t('password.rulesLabel'),
          }}
          minLength={policy.signup.minPasswordLength}
          rules={[
            {
              label: t('password.rule.length').replace(
                '{min}',
                String(policy.signup.minPasswordLength),
              ),
              kind: 'min-length',
            },
            { label: t('password.rule.phrase'), kind: 'note' },
          ]}
        />

        <BrowserTimeZoneInput />

        {required.map((document) => (
          <label
            key={document.key}
            data-testid={`accept-${document.key}`}
            style={{
              display: 'flex',
              gap: spacingTokens.xs,
              alignItems: 'center',
              ...typographyTokens.bodySm,
              marginBlockEnd: spacingTokens.sm,
            }}
          >
            <input type="checkbox" name={`accept:${document.key}`} required />
            <span>
              {t('signUp.accept').replace(
                '{document}',
                locale === 'ar' ? document.title.ar : document.title.en,
              )}
            </span>
            {/* THE VERSION IS PART OF THE ACCEPTANCE. Publishing a new one makes
                an old acceptance stale by construction. */}
            <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
              {document.version}
            </span>
          </label>
        ))}

        {/* Review of #67 — the prototype's trial note (`Auth.dc.html` line 59),
            from the same plan catalogue the workspace form states it from. */}
        {trial ? (
          <p className="bsp-auth-trial" data-testid="signup-trial-note">
            {t('signUp.trialNote')
              .replace('{days}', String(trial.days))
              .replace('{credits}', String(trial.credits))}
          </p>
        ) : null}

        <button type="submit" data-testid="signup-submit" style={authButtonStyle()}>
          {t('signUp.submit')}
        </button>
      </form>
    </AuthCard>
  );
}
