import { colorTokens, spacingTokens } from '@brandspace/ui';
import { translator } from '../../../../i18n/messages';
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
    <main
      id="main"
      style={{ maxInlineSize: '26rem', marginInline: 'auto', padding: spacingTokens.xl }}
    >
      <h1 style={{ color: colorTokens.brandBlueText }} data-testid="heading">
        {t('login.title')}
      </h1>
      <p data-testid="mfa-notice" style={{ color: colorTokens.textSecondary }}>
        {t('login.mfaRequired')}
      </p>

      {error ? (
        <p role="alert" data-testid="login-error" style={{ color: colorTokens.danger }}>
          {locale === 'ar' ? 'بيانات الدخول غير صحيحة.' : 'Invalid credentials.'}
        </p>
      ) : null}

      <form action={signInAction} style={{ display: 'grid', gap: spacingTokens.md }}>
        <input type="hidden" name="locale" value={locale} />
        <div>
          <label htmlFor="email" style={{ display: 'block', marginBlockEnd: spacingTokens.xs }}>
            {t('login.email')}
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="username"
            data-testid="email"
            style={{ inlineSize: '100%', padding: spacingTokens.sm }}
          />
        </div>
        <div>
          <label htmlFor="password" style={{ display: 'block', marginBlockEnd: spacingTokens.xs }}>
            {t('login.password')}
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            data-testid="password"
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
          {t('login.submit')}
        </button>
      </form>
    </main>
  );
}
