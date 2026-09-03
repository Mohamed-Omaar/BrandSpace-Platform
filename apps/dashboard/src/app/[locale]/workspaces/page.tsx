import { colorTokens, radiusTokens, spacingTokens } from '@brandspace/ui';
import {
  getCustomerAuth,
  getSessionToken,
  requireCustomer,
} from '../../../server/customer-context';
import { statusMessage, translator } from '../../../i18n/messages';
import { AuthCard, authButtonStyle } from '../../../components/auth-card';
import { switchWorkspaceAction } from '../(auth)/actions';

export const dynamic = 'force-dynamic';

/**
 * Workspace selection.
 *
 * The list comes from ACTIVE memberships in OPERABLE workspaces only, resolved
 * server-side from the session's user. A workspace the member does not belong
 * to is not in the list, and posting its id is refused with `NOT_FOUND` — the
 * same answer as a workspace that does not exist, so this cannot be used to
 * discover other tenants.
 */
export default async function WorkspacePickerPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  // `requireCustomer` has already redirected if there is no live session, so a
  // token is present here. It is the SESSION TOKEN that selects the workspaces,
  // never the user id: the question "which workspaces may this request act in"
  // is answered from the credential the request actually carries.
  await requireCustomer(locale);
  const workspaces = await getCustomerAuth().listWorkspaces((await getSessionToken()) ?? '');

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  return (
    <AuthCard locale={locale} heading={t('ws.select')}>
      {error && (
        <p role="alert" data-testid="workspace-error" style={{ color: colorTokens.danger }}>
          {statusMessage(error, locale, ref)}
        </p>
      )}

      {workspaces.length === 0 ? (
        <p data-testid="no-workspace">{t('ws.none')}</p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: spacingTokens.sm,
          }}
        >
          {workspaces.map((w) => (
            <li key={w.workspaceId}>
              <form action={switchWorkspaceAction}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="workspaceId" value={w.workspaceId} />
                <button
                  type="submit"
                  data-testid={`choose-workspace-${w.workspaceSlug}`}
                  style={{
                    ...authButtonStyle(),
                    background: colorTokens.surface,
                    color: colorTokens.textPrimary,
                    border: `1px solid ${colorTokens.border}`,
                    borderRadius: radiusTokens.md,
                    textAlign: 'start',
                    paddingInline: spacingTokens.md,
                  }}
                >
                  <strong>{w.workspaceName}</strong>
                  <span style={{ color: colorTokens.textSecondary }}>
                    {' — '}
                    {locale === 'ar' ? w.roleNameAr : w.roleNameEn}
                  </span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </AuthCard>
  );
}
