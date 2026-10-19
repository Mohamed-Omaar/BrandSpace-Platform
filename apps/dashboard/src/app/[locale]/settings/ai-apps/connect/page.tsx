import Link from 'next/link';
import { requireWorkspace } from '../../../../../server/customer-context';
import { brandContextFor } from '../../../../../server/brand-context';
import { listAiAppConnections } from '../../../../../server/ai-apps';
import { SettingsFrame } from '../../../../../components/settings-frame';
import { translator, type MessageKey } from '../../../../../i18n/messages';
import { WorkspaceShell } from '../../../../../components/workspace-shell';

export const dynamic = 'force-dynamic';

/**
 * SETTINGS → CONNECTED AI APPS → CONNECT (D-566).
 *
 * The address to copy into Claude or ChatGPT, and the steps for each, in the
 * reader's language. The address comes from the API (its own public address),
 * never typed here. ChatGPT's plan note is the owner's (2026-10-18, from
 * the vendor's help page "Developer mode and MCP apps in ChatGPT"): writing needs
 * Business, Enterprise or Edu; Pro reads only.
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): Security's card and rows, an
 * ordered list, and a read-only text input the reader selects to copy — no
 * script, no new component.
 */
export default async function ConnectAiAppPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const { customer, workspace, messageLocale } = await requireWorkspace(locale);
  const t = translator(messageLocale);
  const view = await listAiAppConnections();
  const brandContext = await brandContextFor(workspace, '/settings');
  const steps = (prefix: 'claude' | 'chatgpt') =>
    [1, 2, 3, 4].map((n) => t(`aiApps.connect.${prefix}${n}` as MessageKey));

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
      <SettingsFrame
        brandSource={workspace}
        locale={locale}
        permissionKeys={workspace.permissionKeys}
        selected="aiApps"
      >
        <section className="bsp-card bsp-secu" data-testid="ai-apps-connect">
          <div className="bsp-secu-block">
            <div className="bsp-row bsp-secu-row">
              <span className="bsp-secu-text">
                <span className="bsp-secu-t">{t('aiApps.connect.title')}</span>
                <span className="bsp-secu-s">{t('aiApps.connect.intro')}</span>
              </span>
            </div>
          </div>

          <div className="bsp-secu-block">
            <div className="bsp-row bsp-secu-row">
              <span className="bsp-secu-text">
                <span className="bsp-secu-t bsp-sm" id="ai-apps-mcp-url-label">
                  {t('aiApps.connect.urlLabel')}
                </span>
                <span className="bsp-secu-s" id="ai-apps-mcp-url-help">
                  {t('aiApps.connect.urlHelp')}
                </span>
                {view?.mcpUrl ? (
                  <input
                    id="ai-apps-mcp-url"
                    className="bs-control"
                    readOnly
                    dir="ltr"
                    value={view.mcpUrl}
                    aria-labelledby="ai-apps-mcp-url-label"
                    aria-describedby="ai-apps-mcp-url-help"
                    data-testid="ai-apps-mcp-url"
                  />
                ) : null}
              </span>
            </div>
            {view?.mcpUrl ? null : (
              <p className="bsp-secu-panel bsp-secu-note" data-testid="ai-apps-mcp-url-missing">
                {t('aiApps.connect.urlMissing')}
              </p>
            )}
            {view?.reason ? (
              <p className="bsp-secu-panel bsp-secu-note" data-testid="ai-apps-refusal">
                {t(view.reason === 'off' ? 'aiApps.off' : 'aiApps.plan')}
              </p>
            ) : null}
          </div>

          <div className="bsp-secu-block" data-testid="ai-apps-steps-claude">
            <div className="bsp-row bsp-secu-row">
              <span className="bsp-secu-text">
                <span className="bsp-secu-t bsp-sm">{t('aiApps.connect.claude')}</span>
                <ol className="bsp-secu-s">
                  {steps('claude').map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </span>
            </div>
          </div>

          <div className="bsp-secu-block" data-testid="ai-apps-steps-chatgpt">
            <div className="bsp-row bsp-secu-row">
              <span className="bsp-secu-text">
                <span className="bsp-secu-t bsp-sm">{t('aiApps.connect.chatgpt')}</span>
                <ol className="bsp-secu-s">
                  {steps('chatgpt').map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </span>
            </div>
            <p className="bsp-secu-panel bsp-secu-note" data-testid="ai-apps-plans-chatgpt">
              {t('aiApps.connect.chatgptPlans')}
            </p>
          </div>

          <div className="bsp-secu-block" data-testid="ai-apps-try">
            <div className="bsp-row bsp-secu-row">
              <span className="bsp-secu-text">
                <span className="bsp-secu-t bsp-sm">{t('aiApps.connect.try')}</span>
                <ul className="bsp-secu-s">
                  <li>{t('aiApps.connect.try1')}</li>
                  <li>{t('aiApps.connect.try2')}</li>
                  <li>{t('aiApps.connect.try3')}</li>
                </ul>
              </span>
            </div>
            <p className="bsp-secu-panel bsp-secu-note">{t('aiApps.connect.never')}</p>
          </div>

          <div className="bsp-secu-block">
            <div className="bsp-row bsp-secu-row">
              <Link
                href={`/${locale}/settings/ai-apps`}
                className="bsp-btn bsp-sm bsp-sec"
                data-testid="ai-apps-manage-link"
              >
                {t('aiApps.connect.manage')}
              </Link>
            </div>
          </div>
        </section>
      </SettingsFrame>
    </WorkspaceShell>
  );
}
