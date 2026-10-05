import { colorTokens, initialsFrom } from '@brandspace/ui';
import {
  getCustomerAuth,
  getSessionToken,
  requireCustomer,
} from '../../../server/customer-context';
import { statusMessage, translator } from '../../../i18n/messages';
import { AuthCard } from '../../../components/auth-card';
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
  // A8 (D-328): a workspace pending deletion is still listed — marked — so its
  // owner can reach the screen that cancels it. Nothing can be done inside it.
  const workspaces = await getCustomerAuth().listWorkspaces((await getSessionToken()) ?? '', {
    includePendingDeletion: true,
    // G4 (D-333): one that requires two-step is listed; entering it asks for it.
    includeMfaRequired: true,
  });

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  return (
    <AuthCard locale={locale} eyebrow={t('auth.eyebrow.app')} heading={t('ws.select')}>
      {error && (
        <p role="alert" data-testid="workspace-error" style={{ color: colorTokens.danger }}>
          {statusMessage(error, locale, ref)}
        </p>
      )}

      {workspaces.length === 0 ? (
        <p data-testid="no-workspace">{t('ws.none')}</p>
      ) : (
        /* D-468 — the prototype's workspace rows (`Auth.dc.html` lines 97–110). */
        <ul className="bsp-auth-wslist">
          {workspaces.map((w) => (
            <li key={w.workspaceId}>
              <form action={switchWorkspaceAction}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="workspaceId" value={w.workspaceId} />
                <button
                  type="submit"
                  data-testid={`choose-workspace-${w.workspaceSlug}`}
                  className="bs-liftable bsp-auth-ws"
                >
                  <span className="bsp-auth-wsini" aria-hidden="true">
                    {initialsFrom(w.workspaceName)}
                  </span>
                  <span className="bsp-auth-wsmain">
                    <span className="bsp-auth-wsname">{w.workspaceName}</span>
                    <span className="bsp-auth-wsrole">
                      {locale === 'ar' ? w.roleNameAr : w.roleNameEn}
                      {w.deletionScheduledFor ? (
                        <span
                          data-testid={`workspace-pending-deletion-${w.workspaceSlug}`}
                          className="bsp-auth-wsdel"
                        >
                          {' · '}
                          {t('deletion.listTag')}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="bsp-auth-wsgo"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </AuthCard>
  );
}
