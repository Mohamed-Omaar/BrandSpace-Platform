import Link from 'next/link';
import { spacingTokens, typographyTokens } from '@brandspace/ui';
import { translator } from '../../../../i18n/messages';
import { AuthCard, authButtonStyle, authInputStyle } from '../../../../components/auth-card';
import { requestPasswordResetAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Request a password reset.
 *
 * The confirmation is identical whether or not an account exists — the action
 * does not branch visibly on that, so this page cannot be used to discover
 * which addresses are registered.
 */
export default async function ResetRequestPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = translator(locale);

  return (
    <AuthCard
      locale={locale}
      eyebrow={t('auth.eyebrow.password')}
      heading={t('reset.title')}
      footer={
        /* PR D (Auth 4) — "← Back to sign in" (`Auth.dc.html` line 77). */
        <Link href={`/${locale}/sign-in`} data-testid="reset-back">
          <span aria-hidden="true">{locale === 'ar' ? '→' : '←'}</span> {t('reset.backToSignIn')}
        </Link>
      }
    >
      <form action={requestPasswordResetAction}>
        <input type="hidden" name="locale" value={locale} />
        <label htmlFor="email" style={{ display: 'block', ...typographyTokens.label }}>
          {t('signIn.email')}
        </label>
        <input
          className="bs-control"
          id="email"
          name="email"
          type="email"
          required
          style={authInputStyle()}
        />
        <button
          type="submit"
          data-testid="reset-request-submit"
          style={{ ...authButtonStyle(), marginBlockStart: spacingTokens.lg }}
        >
          {t('reset.request')}
        </button>
      </form>
    </AuthCard>
  );
}
