import { Banner, CONTROL_CLASS, Field, spacingTokens } from '@brandspace/ui';
import { translator } from '../../../../i18n/messages';
import { PlatformAuthShell } from '../../../../components/platform-auth';
import { signInAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale } = await params;
  const { error } = await searchParams;
  const t = translator(locale);

  return (
    <PlatformAuthShell
      locale={locale}
      screen="login"
      eyebrow={t('login.eyebrow')}
      heading={t('login.welcome')}
      description={t('login.mfaRequired')}
      descriptionTestId="mfa-notice"
      error={
        error ? (
          /* One generic failure for every cause. The distinction lives in the
             audit log, never in something a caller can observe. */
          <div role="alert" data-testid="login-error">
            <Banner tone="error" testId="login-error-banner">
              {locale === 'ar' ? 'بيانات الدخول غير صحيحة.' : 'Invalid credentials.'}
            </Banner>
          </div>
        ) : null
      }
    >
      {/* The customer sign-in's form, field for field: `entry.css` draws the
          inputs and the button exactly as it does there. */}
      <form action={signInAction}>
        <input type="hidden" name="locale" value={locale} />
        <Field label={t('login.email')} htmlFor="email" required>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="username"
            data-testid="email"
            className={CONTROL_CLASS}
            style={{ inlineSize: '100%' }}
          />
        </Field>
        <Field label={t('login.password')} htmlFor="password" required>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            data-testid="password"
            className={CONTROL_CLASS}
            style={{ inlineSize: '100%' }}
          />
        </Field>
        <button
          type="submit"
          data-testid="submit"
          style={{ inlineSize: '100%', marginBlockStart: spacingTokens.sm }}
        >
          {t('login.submit')}
        </button>
      </form>
    </PlatformAuthShell>
  );
}
