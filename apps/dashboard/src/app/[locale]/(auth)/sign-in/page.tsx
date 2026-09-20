import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Banner, Field, colorTokens, spacingTokens } from '@brandspace/ui';
import { getCustomer, getCustomerAuth, getSessionToken } from '../../../../server/customer-context';
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
  if (existing) {
    const token = await getSessionToken();
    const workspaces = token
      ? await getCustomerAuth()
          .listWorkspaces(token)
          .catch(() => [])
      : [];
    redirect(
      workspaces.length === 0
        ? `/${locale}/onboarding/workspace`
        : `/${locale}/workspaces`,
    );
  }

  const next = typeof query['next'] === 'string' ? query['next'] : '';
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  return (
    <AuthCard
      locale={locale}
      heading={t('signIn.title')}
      description={t('signIn.description')}
      footer={
        <Link href={`/${locale}/reset`} style={{ color: colorTokens.brandPurple }}>
          {t('signIn.forgot')}
        </Link>
      }
    >
      {error && (
        /* A single generic failure, carried as a code. The `signin-error` hook
           and the wording are identical for every cause. */
        <div role="alert" data-testid="signin-error">
          <Banner tone="error" testId="signin-error-banner">
            {statusMessage(error, locale, ref) ?? t('signIn.failed')}
          </Banner>
        </div>
      )}
      {ok && statusMessage(ok, locale) && (
        <div data-testid="signin-status">
          <Banner tone="success" testId="signin-status-banner">
            {statusMessage(ok, locale)}
          </Banner>
        </div>
      )}

      <form action={signInAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="next" value={next} />
        <Field label={t('signIn.email')} htmlFor="email" required>
          <input
            className="bs-control"
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            style={authInputStyle()}
          />
        </Field>
        <Field label={t('signIn.password')} htmlFor="password" required>
          <input
            className="bs-control"
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            style={authInputStyle()}
          />
        </Field>

        <button
          type="submit"
          data-testid="signin-submit"
          style={{ ...authButtonStyle(), marginBlockStart: spacingTokens.sm }}
        >
          {t('signIn.submit')}
        </button>
      </form>
    </AuthCard>
  );
}
