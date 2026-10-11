import Link from 'next/link';
import { colorTokens } from '@brandspace/ui';
import { statusMessage, translator } from '../../../../../i18n/messages';
import { AuthCard, authButtonStyle } from '../../../../../components/auth-card';
import { resendVerificationAction } from '../../actions';
import { ResendButton } from './resend-button';

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
  // Batch 7 PR C (2d): when this page last asked for an email, and the cooldown.
  const at = Number(typeof query['at'] === 'string' ? query['at'] : NaN);
  const wait = Number(typeof query['wait'] === 'string' ? query['wait'] : NaN);
  const again = query['again'] === '1' && !error;

  return (
    <AuthCard locale={locale} eyebrow={t('auth.eyebrow.verify')} heading={t('signUp.sentTitle')}>
      {failure && (
        <p data-testid="signup-resend-error" role="alert" style={{ color: colorTokens.danger }}>
          {failure}
        </p>
      )}
      <p data-testid="signup-sent">{t('signUp.sentBody')}</p>
      {/* PR D (Auth 2) — the address the link went to, in its box (`Auth.dc.html` line 67). */}
      {email ? (
        <div className="bsp-auth-address" data-testid="signup-sent-address">
          <span className="bsp-ltr">{email}</span>
        </div>
      ) : null}
      {again ? (
        <p data-testid="signup-resent" role="status">
          {t('signUp.resent')}
        </p>
      ) : null}
      <form action={resendVerificationAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="email" value={email} />
        <ResendButton
          sentAt={Number.isFinite(at) && !error ? at : null}
          waitSeconds={Number.isFinite(wait) && wait > 0 ? Math.min(wait, 3_600) : 0}
          label={t('signUp.resend')}
          waitLabel={t('signUp.resendIn')}
          sendingLabel={t('signUp.resending')}
          style={authButtonStyle()}
        />
      </form>
      {/*
        PR D (Auth 3) — the prototype's row under the button (line 69): its
        "Send it again" is the button above here; "Wrong email?" goes back to
        sign-up with the address to correct.
      */}
      <div className="bsp-auth-row">
        <Link href={`/${locale}/sign-in`} style={{ color: colorTokens.brandPurple }}>
          {t('verify.signIn')}
        </Link>
        <Link
          href={`/${locale}/sign-up${email ? `?email=${encodeURIComponent(email)}` : ''}`}
          data-testid="signup-wrong-email"
          style={{ color: colorTokens.brandPurple }}
        >
          {t('signUp.wrongEmail')}
        </Link>
      </div>
    </AuthCard>
  );
}
