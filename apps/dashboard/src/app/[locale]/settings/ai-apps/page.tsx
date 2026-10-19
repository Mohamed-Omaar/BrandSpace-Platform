import Link from 'next/link';
import { requireWorkspace } from '../../../../server/customer-context';
import { brandContextFor } from '../../../../server/brand-context';
import { listAiAppConnections } from '../../../../server/ai-apps';
import { SettingsFrame } from '../../../../components/settings-frame';
import { statusMessage, translator } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { revokeAiAppAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * SETTINGS → CONNECTED AI APPS (D-566).
 *
 * Each AI app that can work in Brandspace as a member: which app, who
 * connected it, which brands, connected on, last used — and Revoke, in two
 * steps like disconnecting an account (CLAUDE.md §2.5). Open to every member
 * (owner answer Q2): a member sees their own connections; one holding
 * `integrations.manage` sees and may revoke everyone's. The API decides both.
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2, UI-FIDELITY-CONTRACT §6): no
 * approved reference draws this screen, so it is composed from Security's own
 * card, rows and buttons (`bsp-card bsp-secu`, `bsp-secu-row`, `bsp-btn`) and
 * the Connections page's two-step disconnect (`bsp-acc-disc`, `bsp-acc-confirm`,
 * `bsp-acc-danger`). No new component, colour or interaction.
 */
export default async function ConnectedAiAppsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const { customer, workspace, messageLocale } = await requireWorkspace(locale);
  const t = translator(messageLocale);
  const view = await listAiAppConnections();
  const brandContext = await brandContextFor(workspace, '/settings');
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const dateOf = (iso: string) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
      dateStyle: 'medium',
      numberingSystem: 'latn',
      timeZone: 'UTC',
    }).format(new Date(iso));

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('nav.settings')}
      description={t('settings.p.subtitle')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}
      <SettingsFrame
        brandSource={workspace}
        locale={locale}
        permissionKeys={workspace.permissionKeys}
        selected="aiApps"
      >
        <section className="bsp-card bsp-secu" data-testid="ai-apps">
          <div className="bsp-secu-block">
            <div className="bsp-row bsp-secu-row">
              <span className="bsp-secu-text">
                <span className="bsp-secu-t">{t('aiApps.title')}</span>
                <span className="bsp-secu-s">{t('aiApps.intro')}</span>
              </span>
              <Link
                href={`/${locale}/settings/ai-apps/connect`}
                className="bsp-btn bsp-sm bsp-pur"
                data-testid="ai-apps-connect-link"
              >
                {t('aiApps.connectLink')}
              </Link>
            </div>
          </div>

          {view === null ? (
            <p className="bsp-secu-panel bsp-secu-note" data-testid="ai-apps-unavailable">
              {t('aiApps.unavailable')}
            </p>
          ) : (
            <>
              {view.reason ? (
                <p className="bsp-secu-panel bsp-secu-note" data-testid="ai-apps-refusal">
                  {t(view.reason === 'off' ? 'aiApps.off' : 'aiApps.plan')}
                </p>
              ) : null}
              {view.manageAll ? (
                <p className="bsp-secu-panel bsp-secu-note" data-testid="ai-apps-manage-all">
                  {t('aiApps.everyoneNote')}
                </p>
              ) : null}
              {view.connections.length === 0 ? (
                <p className="bsp-secu-panel bsp-secu-note" data-testid="ai-apps-empty">
                  {t(view.manageAll ? 'aiApps.emptyAll' : 'aiApps.empty')}
                </p>
              ) : (
                view.connections.map((row) => (
                  <div key={row.id} className="bsp-secu-block" data-testid={`ai-app-${row.id}`}>
                    <div className="bsp-row bsp-secu-row">
                      <span className="bsp-secu-text">
                        <span className="bsp-secu-t bsp-sm" data-testid="ai-app-name">
                          {row.app}
                        </span>
                        <span className="bsp-secu-s">
                          {view.manageAll ? (
                            <>
                              {t('aiApps.connectedBy')}: {row.person ?? t('aiApps.formerMember')}
                              {' · '}
                            </>
                          ) : null}
                          {t('aiApps.brands')}:{' '}
                          {row.brands === 'all' ? t('aiApps.allBrands') : row.brands.join(', ')}
                        </span>
                        <span className="bsp-secu-s">
                          {t('aiApps.access')}:{' '}
                          {t(row.canWrite ? 'aiApps.accessWrite' : 'aiApps.accessRead')}
                          {' · '}
                          {t('aiApps.connectedOn')}: {dateOf(row.createdAt)}
                          {' · '}
                          {t('aiApps.lastUsed')}:{' '}
                          <span data-testid="ai-app-last-used">
                            {row.lastUsedAt ? dateOf(row.lastUsedAt) : t('aiApps.neverUsed')}
                          </span>
                        </span>
                      </span>
                      <details className="bsp-acc-disc">
                        <summary
                          className="bsp-btn bsp-sm bsp-ghost"
                          data-testid={`ai-app-revoke-${row.id}`}
                        >
                          {t('aiApps.revoke')}
                        </summary>
                        <form action={revokeAiAppAction} className="bsp-acc-confirm">
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="connectionId" value={row.id} />
                          <input type="hidden" name="intent" value="REVOKE" />
                          <span className="bsp-acc-sub">{t('aiApps.revokeBody')}</span>
                          <button
                            type="submit"
                            className="bsp-btn bsp-sm bsp-acc-danger"
                            data-testid={`ai-app-revoke-confirm-${row.id}`}
                          >
                            {t('aiApps.revokeConfirm')}
                          </button>
                        </form>
                      </details>
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </section>
      </SettingsFrame>
    </WorkspaceShell>
  );
}
