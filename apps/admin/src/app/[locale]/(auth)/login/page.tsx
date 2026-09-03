import { Banner, Button, CONTROL_CLASS, Field, inputStyle, spacingTokens } from '@brandspace/ui';
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
      heading={t('login.title')}
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
      <form action={signInAction} style={{ display: 'grid', gap: spacingTokens.xs }}>
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
            style={inputStyle({ size: 'lg' })}
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
            style={inputStyle({ size: 'lg' })}
          />
        </Field>
        <Button
          type="submit"
          size="lg"
          fullWidth
          data-testid="submit"
          style={{ marginBlockStart: spacingTokens.sm }}
        >
          {t('login.submit')}
        </Button>
      </form>
    </PlatformAuthShell>
  );
}
