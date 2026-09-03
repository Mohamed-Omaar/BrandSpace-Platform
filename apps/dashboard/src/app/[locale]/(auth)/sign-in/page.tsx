import Link from 'next/link';
import { redirect } from 'next/navigation';
import { colorTokens, spacingTokens } from '@brandspace/ui';
import { getCustomer } from '../../../../server/customer-context';
import { statusMessage, translator } from '../../../../i18n/messages';
import { AuthCard, authButtonStyle, authInputStyle } from '../../../../components/auth-card';
import { signInAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Customer sign-in.
 *
 * A single generic failure for every cause — unknown address, wrong password,
 * suspended account, passwordless (invitation-only) account, locked account.
 * The distinction lives in the audit log, where it helps an operator, and
 * nowhere a caller can observe it (docs/SECURITY.md §3).
 */
export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);

  // Already signed in: there is nothing to do here.
  const existing = await getCustomer().catch(() => null);
  if (existing) redirect(`/${locale}/workspaces`);

  const next = typeof query['next'] === 'string' ? query['next'] : '';
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  return (
    <AuthCard locale={locale} heading={t('signIn.title')}>
      {error && (
        <p role="alert" data-testid="signin-error" style={{ color: colorTokens.danger }}>
          {statusMessage(error, locale, ref) ?? t('signIn.failed')}
        </p>
      )}
      {ok && statusMessage(ok, locale) && (
        <p role="status" data-testid="signin-status" style={{ color: colorTokens.success }}>
          {statusMessage(ok, locale)}
        </p>
      )}

      <form action={signInAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="next" value={next} />
        <label htmlFor="email" style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem' }}>
          {t('signIn.email')}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          style={authInputStyle()}
        />

        <label
          htmlFor="password"
          style={{
            display: 'block',
            fontWeight: 600,
            fontSize: '0.875rem',
            marginBlockStart: spacingTokens.md,
          }}
        >
          {t('signIn.password')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          style={authInputStyle()}
        />

        <button
          type="submit"
          data-testid="signin-submit"
          style={{ ...authButtonStyle(), marginBlockStart: spacingTokens.lg }}
        >
          {t('signIn.submit')}
        </button>
      </form>

      <p style={{ marginBlockStart: spacingTokens.md, fontSize: '0.875rem' }}>
        <Link href={`/${locale}/reset`} style={{ color: colorTokens.brandPurple }}>
          {t('signIn.forgot')}
        </Link>
      </p>
    </AuthCard>
  );
}
