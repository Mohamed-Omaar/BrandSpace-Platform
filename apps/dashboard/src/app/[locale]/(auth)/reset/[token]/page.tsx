import { PasswordField, colorTokens, spacingTokens } from '@brandspace/ui';
import { statusMessage, translator } from '../../../../../i18n/messages';
import { AuthCard, authButtonStyle } from '../../../../../components/auth-card';
import { completePasswordResetAction } from '../../actions';
import { signupPolicy } from '../../../../../server/signup-policy';

export const dynamic = 'force-dynamic';

/**
 * Set a new password from a reset link.
 *
 * The token is NOT validated here: doing so would tell a holder whether a token
 * is live before they commit to using it. It is consumed atomically by the
 * action, which requires exactly one affected row, so two concurrent requests
 * cannot both spend it.
 */
export default async function ResetCompletePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, token } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  const { minPasswordLength } = await signupPolicy();

  return (
    <AuthCard locale={locale} heading={t('reset.title')}>
      {error && (
        <p role="alert" data-testid="reset-error" style={{ color: colorTokens.danger }}>
          {statusMessage(error, locale, ref)}
        </p>
      )}
      <form action={completePasswordResetAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="token" value={token} />
        {/*
          THE CONFIGURED MINIMUM AND THE SHARED CONTROL (P6-03a).

          `minLength={12}` was typed here, so this screen and the sign-up form
          could disagree about the policy and the customer would be told
          whichever number happened to be nearest. It now reads the same
          configuration the server action validates against, and uses the same
          component as every other password screen — which is what gives it the
          reveal toggle, the confirmation and the rules it had none of.
        */}
        <PasswordField
          id="password"
          labels={{
            label: t('reset.newPassword'),
            show: t('password.show'),
            hide: t('password.hide'),
            confirmLabel: t('password.confirm'),
            mismatch: t('password.mismatch'),
            match: t('password.match'),
            rulesLabel: t('password.rulesLabel'),
          }}
          minLength={minPasswordLength}
          rules={[
            {
              label: t('password.rule.length').replace('{min}', String(minPasswordLength)),
              kind: 'min-length',
            },
            { label: t('password.rule.phrase'), kind: 'note' },
          ]}
        />
        <button
          type="submit"
          data-testid="reset-submit"
          style={{ ...authButtonStyle(), marginBlockStart: spacingTokens.lg }}
        >
          {t('reset.submit')}
        </button>
      </form>
    </AuthCard>
  );
}
