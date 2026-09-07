import { colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { InvitationService } from '@brandspace/auth';
import { getPrisma } from '@brandspace/database';
import { getCustomer } from '../../../../server/customer-context';
import { statusMessage, translator } from '../../../../i18n/messages';
import { AuthCard, authButtonStyle } from '../../../../components/auth-card';
import { acceptInvitationAction } from '../../(auth)/actions';

export const dynamic = 'force-dynamic';

/**
 * Invitation acceptance.
 *
 * `peek()` shows the workspace and role to a holder of a VALID token and throws
 * the same error for every unusable one — expired, revoked, already accepted,
 * superseded, or simply wrong. It never reveals whether an account exists for
 * the invited address.
 *
 * Acceptance requires a signed-in identity, because an invitation binds to a
 * proven account rather than to whoever opened the link.
 */
export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, token } = await params;
  const query = await searchParams;
  const t = translator(locale);

  // `peek` MANAGES ITS OWN CONTEXT: it reads the invitation under the
  // token scope (migration 20260903100000), then reads the workspace and role
  // inside that workspace, under the ordinary tenant policies. It therefore
  // needs the full tenant client, not a pre-scoped transaction.
  const invitation = await new InvitationService({ prisma: getPrisma() })
    .peek(token)
    .catch(() => null);
  const customer = await getCustomer().catch(() => null);

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  if (!invitation) {
    return (
      <AuthCard locale={locale} heading={t('invite.title')}>
        <p role="alert" data-testid="invitation-invalid" style={{ color: colorTokens.danger }}>
          {t('invite.invalid')}
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard locale={locale} heading={t('invite.title')}>
      {error && (
        <p role="alert" data-testid="invitation-error" style={{ color: colorTokens.danger }}>
          {statusMessage(error, locale, ref) ?? t('invite.invalid')}
        </p>
      )}

      <dl style={{ margin: 0, marginBlockEnd: spacingTokens.lg, ...typographyTokens.bodySm }}>
        <dt style={{ fontWeight: 600 }}>{t('invite.workspace')}</dt>
        <dd
          data-testid="invitation-workspace"
          style={{ marginInlineStart: 0, marginBlockEnd: spacingTokens.sm }}
        >
          {invitation.workspaceName}
        </dd>
        <dt style={{ fontWeight: 600 }}>{t('invite.role')}</dt>
        <dd data-testid="invitation-role" style={{ marginInlineStart: 0 }}>
          {locale === 'ar' ? invitation.roleNameAr : invitation.roleNameEn}
        </dd>
      </dl>

      {customer ? (
        <form action={acceptInvitationAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="token" value={token} />
          <button type="submit" data-testid="invitation-accept" style={authButtonStyle()}>
            {t('invite.accept')}
          </button>
        </form>
      ) : (
        <>
          <p data-testid="invitation-signin-first">{t('invite.signInFirst')}</p>
          <a
            href={`/${locale}/sign-in?next=${encodeURIComponent(`/${locale}/invitations/${token}`)}`}
            data-testid="invitation-signin-link"
            style={{
              ...authButtonStyle(),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textDecoration: 'none',
            }}
          >
            {t('signIn.submit')}
          </a>
        </>
      )}
    </AuthCard>
  );
}
