import Link from 'next/link';
import { colorTokens } from '@brandspace/ui';
import { statusMessage, translator } from '../../../../../i18n/messages';
import { AuthCard, authButtonStyle } from '../../../../../components/auth-card';
import { resendVerificationAction } from '../../actions';

export const dynamic = 'force-dynamic';

/**
 * "Check your email".
 *
 * THE COPY IS CONDITIONAL AND THE PAGE IS NOT. It says a message is on its way
 * IF the address can be registered — which is true whether the address was free
 * or already taken, and is what stops this page confirming that an account
 * exists (§10).
 */
export default async function SignUpSentPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = translator(locale);
  const query = await searchParams;
  const email = typeof query['email'] === 'string' ? query['email'] : '';
  /*
   * A RESEND THAT FAILED SAYS SO — Phase 4 §4.
   *
   * The action used to swallow every failure and land here regardless, so a
   * customer whose first link never arrived could press "send again" against a
   * broken provider for ever and be told each time that it had worked.
   */
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  const failure = statusMessage(error, locale, ref);

  return (
    <AuthCard locale={locale} heading={t('signUp.sentTitle')}>
      {failure && (
        <p data-testid="signup-resend-error" role="alert" style={{ color: colorTokens.danger }}>
          {failure}
        </p>
      )}
      <p data-testid="signup-sent">{t('signUp.sentBody')}</p>
      <form action={resendVerificationAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="email" value={email} />
        <button type="submit" data-testid="signup-resend" style={authButtonStyle()}>
          {t('signUp.resend')}
        </button>
      </form>
      <Link href={`/${locale}/sign-in`} style={{ color: colorTokens.brandPurple }}>
        {t('verify.signIn')}
      </Link>
    </AuthCard>
  );
}
