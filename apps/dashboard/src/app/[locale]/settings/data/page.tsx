import Link from 'next/link';
import { TenantOnboardingPolicySource } from '@brandspace/onboarding';
import {
  currentEnvironment,
  inWorkspace,
  requireWorkspacePage,
} from '../../../../server/customer-context';
import { NoAccessPage } from '../../../../components/no-access-page';
import { brandContextFor } from '../../../../server/brand-context';
import { SettingsFrame } from '../../../../components/settings-frame';
import { statusMessage, translator, type MessageKey } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { requestWorkspaceDeletionAction } from './actions';
import { RetentionCard } from '../retention-card';

export const dynamic = 'force-dynamic';

/**
 * DATA CONTROLS (P6-13) — every control this product has over a workspace's
 * data, in one place, and a plain statement of the ones it does not have.
 *
 * NOTHING HERE IS A NEW CONTROL. Each available row links to the screen where
 * that control already lives and already enforces its own permission — the AI
 * content retention form on Workspace settings, the analytics export, the
 * accounting export, the Brand Brain source documents. A row is shown as
 * available only when this member could actually use it.
 *
 * THE MISSING ONES ARE SAID, NOT HIDDEN. There is no self-serve export of a
 * whole workspace, so it is listed as "not available" with no invented process
 * attached.
 *
 * WORKSPACE DELETION (A8, D-328) is the Owner's (`workspace.delete`): the
 * danger card says what happens and when, and submits with the workspace's
 * name typed back and the password. Other members see who can do it.
 *
 * Round 4, Gate 2b: the prototype's Data section (see below).
 */
export default async function DataControlsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const access = await requireWorkspacePage(locale, '/settings/data');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;
  const may = (key: string) => workspace.permissionKeys.includes(key);

  const { retentionDays, graceDays } = await inWorkspace(workspace.workspaceId, async ({ db }) => {
    const row = await db.workspace.findUniqueOrThrow({
      where: { id: workspace.workspaceId },
      select: { aiContentRetentionDays: true },
    });
    const policy = await new TenantOnboardingPolicySource(db, currentEnvironment()).load();
    return {
      retentionDays: row.aiContentRetentionDays,
      graceDays: policy.workspaceDeletion.graceDays,
    };
  });
  const mayDelete = may('workspace.delete');
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  const number = new Intl.NumberFormat('en-US');

  const controls: readonly {
    key: string;
    available: boolean;
    detail?: string;
    href?: string;
  }[] = [
    {
      key: 'retention',
      available: true,
      detail:
        retentionDays === null
          ? t('data.retention.default')
          : t('data.retention.days').replace('{days}', number.format(retentionDays)),
      href: '/settings',
    },
    ...(may('analytics.export')
      ? [{ key: 'analyticsExport', available: true, href: '/analytics' }]
      : []),
    ...(may('billing.read')
      ? [{ key: 'accountingExport', available: true, href: '/billing' }]
      : []),
    ...(may('brand_brain.read')
      ? [{ key: 'brandSources', available: true, href: '/brand-brain' }]
      : []),
    { key: 'workspaceExport', available: false },
  ];

  const brandContext = await brandContextFor(workspace, '/settings');

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
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}
      <SettingsFrame
        brandSource={workspace}
        locale={locale}
        permissionKeys={workspace.permissionKeys}
        selected="data"
      >
        {/*
          ROUND 4, GATE 2b — THE PROTOTYPE'S DATA SECTION (`Main.dc.html` lines
          1376–1379): one `xcard` row per control (the title at 14px / 600 over
          its 12px line, the action at the end), the retention card, then the
          danger card with its red border, title and inline confirmation.
          Every control is the product's own, linking where it lives; the
          one that does not exist (a whole-workspace export) still says so.
        */}
        <div className="bsp-dt" data-testid="data-controls">
          {controls.map((control) => (
            <section
              key={control.key}
              className="bsp-xcard bsp-dt-row"
              data-testid={`data-control-${control.key}`}
            >
              <span className="bsp-dt-text">
                <span className="bsp-dt-title">{t(`data.${control.key}.title` as MessageKey)}</span>
                <span className="bsp-dt-sub">
                  {control.detail ?? t(`data.${control.key}.body` as MessageKey)}
                </span>
              </span>
              {control.available && control.href ? (
                <Link href={`/${locale}${control.href}`} className="bsp-btn bsp-sm">
                  {t('data.open')}
                </Link>
              ) : (
                <span className="bsp-pill bsp-p-neu">{t('data.unavailable')}</span>
              )}
            </section>
          ))}

          {/* Review of #67 — retention lives in Data, as the prototype states it. */}
          <RetentionCard locale={locale} workspaceId={workspace.workspaceId} />

          <section className="bsp-xcard bsp-dt-danger" data-testid="workspace-deletion">
            <span className="bsp-dt-title bsp-dt-danger-t">
              {t('data.workspaceDeletion.title')}
            </span>
            <span className="bsp-dt-sub">
              {t('data.workspaceDeletion.body').replace('{days}', number.format(graceDays))}
            </span>
            {mayDelete ? (
              /*
                The prototype's inline confirmation: the business name typed
                back, then the red button. The product also asks for the
                password, and the server checks both (D-328).
              */
              <form action={requestWorkspaceDeletionAction} className="bsp-dt-confirm">
                <input type="hidden" name="locale" value={locale} />
                <input
                  id="typedWorkspaceName"
                  name="typedWorkspaceName"
                  required
                  dir="auto"
                  autoComplete="off"
                  className="bs-control bsp-dt-input"
                  placeholder={workspace.workspaceName}
                  aria-label={t('data.workspaceDeletion.confirmName').replace(
                    '{name}',
                    workspace.workspaceName,
                  )}
                  data-testid="workspace-deletion-name"
                />
                <input
                  id="deletionPassword"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  className="bs-control bsp-dt-input bsp-dt-pass"
                  placeholder={t('data.workspaceDeletion.password')}
                  aria-label={t('data.workspaceDeletion.password')}
                  data-testid="workspace-deletion-password"
                />
                <button
                  type="submit"
                  className="bsp-btn bsp-dt-del"
                  data-testid="workspace-deletion-confirm"
                >
                  {t('data.workspaceDeletion.confirm')}
                </button>
              </form>
            ) : (
              <span className="bsp-pill bsp-p-neu bsp-dt-owner">
                {t('data.workspaceDeletion.ownerOnly')}
              </span>
            )}
          </section>
        </div>
      </SettingsFrame>
    </WorkspaceShell>
  );
}
