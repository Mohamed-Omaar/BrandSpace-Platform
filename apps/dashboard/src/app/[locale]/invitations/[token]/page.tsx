import { Field, colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { InvitationService } from '@brandspace/auth';
import { getPrisma } from '@brandspace/database';
import { getCustomer } from '../../../../server/customer-context';
import { statusMessage, translator } from '../../../../i18n/messages';
import { AuthCard, authButtonStyle, authInputStyle } from '../../../../components/auth-card';
import { acceptInvitationAction, onboardInvitationAction } from '../../(auth)/actions';

export const dynamic = 'force-dynamic';

/**
 * Invitation acceptance.
 *
 * `peek()` shows the workspace and role to a holder of a VALID token and throws
 * the same error for every unusable one — expired, revoked, already accepted,
 * superseded, or simply wrong. It never reveals whether an account exists for
 * the invited address.
 *
 * Acceptance requires a proven identity, because an invitation binds to an
 * account rather than to whoever opened the link. There are two ways to prove
 * one, and A-2 added the second:
 *
 *   - SIGN IN, when the invitee already has an account;
 *   - SET A PASSWORD, when they do not. The token was delivered to the invited
 *     mailbox and exists nowhere else — the database holds only its hash — so
 *     presenting it demonstrates control of that address. The identity is
 *     created from the address the INVITATION names, never from a form field.
 *
 * BOTH ARE ALWAYS OFFERED, and the page never checks which applies. Rendering
 * one or the other would tell anyone holding a forwarded link whether the
 * invited address is registered; the service refuses the wrong one with the
 * ordinary failure message.
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

          <form action={onboardInvitationAction} style={{ display: 'grid', gap: spacingTokens.sm }}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="token" value={token} />
            <p
              data-testid="invitation-setup-title"
              style={{ ...typographyTokens.bodySm, fontWeight: 600, margin: 0 }}
            >
              {t('invite.setUpTitle')}
            </p>
            <p
              style={{
                ...typographyTokens.caption,
                color: colorTokens.textSecondary,
                margin: 0,
              }}
            >
              {t('invite.setUpHint')}
            </p>
            {/*
              NO EMAIL FIELD, deliberately. The address comes from the
              invitation row; letting the form supply one would make this a way
              to create an account for somebody else's address.
            */}
            <Field label={t('invite.password')} htmlFor="invite-password" required>
              <input
                className="bs-control"
                id="invite-password"
                name="password"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                aria-describedby="invite-password-hint"
                data-testid="invitation-password"
                style={authInputStyle()}
              />
            </Field>
            <p
              id="invite-password-hint"
              style={{
                ...typographyTokens.caption,
                color: colorTokens.textSecondary,
                margin: 0,
              }}
            >
              {t('invite.passwordHint')}
            </p>
            <button type="submit" data-testid="invitation-setup-submit" style={authButtonStyle()}>
              {t('invite.setUpSubmit')}
            </button>
          </form>

          <p style={{ ...typographyTokens.caption, marginBlockStart: spacingTokens.md }}>
            <a
              href={`/${locale}/sign-in?next=${encodeURIComponent(
                `/${locale}/invitations/${token}`,
              )}`}
              data-testid="invitation-signin-link"
              style={{ color: colorTokens.textPrimary }}
            >
              {t('invite.haveAccount')}
            </a>
          </p>
        </>
      )}
    </AuthCard>
  );
}
