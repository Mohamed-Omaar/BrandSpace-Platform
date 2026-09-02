import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { PLATFORM_REALM } from '@brandspace/auth';
import { colorTokens, spacingTokens } from '@brandspace/ui';
import { translator } from '../../../../i18n/messages';
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
    <main
      id="main"
      style={{ maxInlineSize: '26rem', marginInline: 'auto', padding: spacingTokens.xl }}
    >
      <h1 style={{ color: colorTokens.brandBlueText }} data-testid="heading">
        {t('mfa.title')}
      </h1>
      <p style={{ color: colorTokens.textSecondary }} data-testid="description">
        {t('mfa.recoveryHint')}
      </p>

      {error ? (
        <p role="alert" data-testid="mfa-error" style={{ color: colorTokens.danger }}>
          {locale === 'ar' ? 'رمز التحقق غير صحيح.' : 'Invalid verification code.'}
        </p>
      ) : null}

      <form action={verifyMfaAction} style={{ display: 'grid', gap: spacingTokens.md }}>
        <input type="hidden" name="locale" value={locale} />
        <div>
          <label htmlFor="code" style={{ display: 'block', marginBlockEnd: spacingTokens.xs }}>
            {t('mfa.code')}
          </label>
          <input
            id="code"
            name="code"
            inputMode="text"
            autoComplete="one-time-code"
            required
            data-testid="mfa-code"
            style={{ inlineSize: '100%', padding: spacingTokens.sm }}
          />
        </div>
        <button
          type="submit"
          data-testid="submit"
          style={{
            padding: spacingTokens.sm,
            background: colorTokens.brandBlueSurface,
            color: colorTokens.brandBlueInk,
            border: 'none',
            borderRadius: '0.5rem',
            cursor: 'pointer',
          }}
        >
          {t('mfa.submit')}
        </button>
      </form>
    </main>
  );
}
