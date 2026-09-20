import { redirect } from 'next/navigation';
import { Banner, Field } from '@brandspace/ui';
import {
  customerLandingPath,
  getCustomer,
  getSessionToken,
} from '../../../../server/customer-context';
import { translator } from '../../../../i18n/messages';
import { AuthCard, authButtonStyle, authInputStyle } from '../../../../components/auth-card';
import { verifyMfaAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * The second factor.
 *
 * REACHED WITH A SESSION THAT GRANTS NOTHING. `getCustomer()` returns null for a
 * session whose MFA is unverified, which is why this page checks for the
 * OPPOSITE: a customer who already resolves has nothing to do here and is sent
 * on. Everything else — no session at all, an expired one — lands on sign-in
 * through the action.
 *
 * A wrong code is an ordinary failure with a generic message, counted against
 * the account's lockout. Six digits without a limit would reduce a stolen
 * password to a million guesses.
 */
export default async function MfaChallengePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = translator(locale);
  const query = await searchParams;

  const resolved = await getCustomer().catch(() => null);
  if (resolved) {
    const token = await getSessionToken();
    redirect(token ? await customerLandingPath(locale, token) : `/${locale}/workspaces`);
  }

  const error = typeof query['error'] === 'string' ? query['error'] : null;

  return (
    <AuthCard
      locale={locale}
      heading={t('mfa.challengeTitle')}
      description={t('mfa.challengeBody')}
    >
      {error ? (
        <div role="alert" data-testid="mfa-error">
          <Banner tone="error">{t('mfa.failed')}</Banner>
        </div>
      ) : null}
      <form action={verifyMfaAction} data-testid="mfa-form">
        <input type="hidden" name="locale" value={locale} />
        <Field label={t('mfa.code')} htmlFor="code" required>
          <input
            className="bs-control"
            id="code"
            name="code"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={32}
            style={authInputStyle()}
          />
        </Field>
        <button type="submit" data-testid="mfa-submit" style={authButtonStyle()}>
          {t('mfa.confirm')}
        </button>
      </form>
    </AuthCard>
  );
}
