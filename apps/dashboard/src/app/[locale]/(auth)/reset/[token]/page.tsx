import { colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { statusMessage, translator } from '../../../../../i18n/messages';
import { AuthCard, authButtonStyle, authInputStyle } from '../../../../../components/auth-card';
import { completePasswordResetAction } from '../../actions';

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
        <label htmlFor="password" style={{ display: 'block', ...typographyTokens.label }}>
          {t('reset.newPassword')}
        </label>
        <input
          className="bs-control"
          id="password"
          name="password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          style={authInputStyle()}
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
