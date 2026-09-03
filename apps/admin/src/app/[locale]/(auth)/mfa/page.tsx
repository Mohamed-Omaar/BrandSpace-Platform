import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { PLATFORM_REALM } from '@brandspace/auth';
import { Banner, Button, CONTROL_CLASS, Field, inputStyle, spacingTokens } from '@brandspace/ui';
import { translator } from '../../../../i18n/messages';
import { PlatformAuthShell } from '../../../../components/platform-auth';
import { verifyMfaAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function MfaPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale } = await params;
  const { error } = await searchParams;
  const t = translator(locale);

  // Without a pre-MFA session there is nothing to verify.
  const store = await cookies();
  if (!store.get(PLATFORM_REALM.cookieName)?.value) redirect(`/${locale}/login`);

  return (
    <PlatformAuthShell
      heading={t('mfa.title')}
      description={t('mfa.recoveryHint')}
      descriptionTestId="description"
      error={
        error ? (
          <div role="alert" data-testid="mfa-error">
            <Banner tone="error" testId="mfa-error-banner">
              {locale === 'ar' ? 'رمز التحقق غير صحيح.' : 'Invalid verification code.'}
            </Banner>
          </div>
        ) : null
      }
    >
      <form action={verifyMfaAction} style={{ display: 'grid', gap: spacingTokens.xs }}>
        <input type="hidden" name="locale" value={locale} />
        <Field label={t('mfa.code')} htmlFor="code" required>
          <input
            id="code"
            name="code"
            inputMode="text"
            autoComplete="one-time-code"
            required
            data-testid="mfa-code"
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
          {t('mfa.submit')}
        </Button>
      </form>
    </PlatformAuthShell>
  );
}
