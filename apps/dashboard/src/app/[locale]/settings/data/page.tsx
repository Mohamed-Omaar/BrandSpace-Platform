import Link from 'next/link';
import {
  Card,
  Field,
  SectionHeader,
  SettingsSplit,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { TenantOnboardingPolicySource } from '@brandspace/onboarding';
import {
  currentEnvironment,
  inWorkspace,
  requireWorkspacePage,
} from '../../../../server/customer-context';
import { NoAccessPage } from '../../../../components/no-access-page';
import { brandContextFor } from '../../../../server/brand-context';
import { settingsNavItems } from '../../../../server/settings-nav';
import { statusMessage, translator, type MessageKey } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { requestWorkspaceDeletionAction } from './actions';

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
 * WORKSPACE DELETION (A8, D-328) is the Owner's (`workspace.delete`): two steps
 * in the no-JavaScript `<details>` pattern — the first click explains what
 * happens and when, the second submits with the workspace's name typed back
 * and the password. Other members see who can do it.
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): the same `SettingsSplit`, `Card`,
 * `SectionHeader` and `StatusBadge` the other Settings sections use.
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
  const t = translator(locale);
  const access = await requireWorkspacePage(locale, '/settings/data');
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

  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en');

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
      heading={t('settings.data')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}
      <SettingsSplit
        navLabel={t('settings.navLabel')}
        items={settingsNavItems({
          locale,
          permissionKeys: workspace.permissionKeys,
          selected: 'data',
        }).map((item) => ({ href: item.href, label: t(item.labelKey), selected: item.selected }))}
      >
        <Card testId="data-controls">
          <SectionHeader title={t('settings.data')} description={t('data.subtitle')} />
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: spacingTokens.md,
            }}
          >
            {controls.map((control) => (
              <li
                key={control.key}
                data-testid={`data-control-${control.key}`}
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: spacingTokens.sm,
                }}
              >
                <span style={{ display: 'grid', gap: '0.125rem', minInlineSize: 0 }}>
                  <strong style={typographyTokens.bodySm}>
                    {t(`data.${control.key}.title` as MessageKey)}
                  </strong>
                  <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                    {control.detail ?? t(`data.${control.key}.body` as MessageKey)}
                  </span>
                </span>
                {control.available && control.href ? (
                  <Link
                    href={`/${locale}${control.href}`}
                    style={buttonStyle('ghost', 'sm')}
                    className={buttonClass('ghost')}
                  >
                    {t('data.open')}
                  </Link>
                ) : (
                  <StatusBadge tone="neutral" label={t('data.unavailable')} />
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card testId="workspace-deletion">
          <SectionHeader
            title={t('data.workspaceDeletion.title')}
            description={t('data.workspaceDeletion.body').replace(
              '{days}',
              number.format(graceDays),
            )}
          />
          {mayDelete ? (
            <details>
              <summary
                style={{ ...buttonStyle('neutral'), listStyle: 'none', display: 'inline-flex' }}
                data-testid="workspace-deletion-open"
              >
                {t('data.workspaceDeletion.start')}
              </summary>
              <form
                action={requestWorkspaceDeletionAction}
                style={{
                  display: 'grid',
                  gap: spacingTokens.sm,
                  marginBlockStart: spacingTokens.sm,
                }}
              >
                <input type="hidden" name="locale" value={locale} />
                <p style={{ ...typographyTokens.bodySm, margin: 0, color: colorTokens.danger }}>
                  {t('data.workspaceDeletion.warning').replace('{days}', number.format(graceDays))}
                </p>
                <Field
                  label={t('data.workspaceDeletion.confirmName').replace(
                    '{name}',
                    workspace.workspaceName,
                  )}
                  htmlFor="typedWorkspaceName"
                  required
                >
                  <input
                    id="typedWorkspaceName"
                    name="typedWorkspaceName"
                    required
                    autoComplete="off"
                    className="bs-control"
                    style={inputStyle()}
                    data-testid="workspace-deletion-name"
                  />
                </Field>
                <Field
                  label={t('data.workspaceDeletion.password')}
                  htmlFor="deletionPassword"
                  required
                >
                  <input
                    id="deletionPassword"
                    name="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    className="bs-control"
                    style={inputStyle()}
                    data-testid="workspace-deletion-password"
                  />
                </Field>
                <div>
                  <button
                    type="submit"
                    style={buttonStyle('danger')}
                    data-testid="workspace-deletion-confirm"
                  >
                    {t('data.workspaceDeletion.confirm')}
                  </button>
                </div>
              </form>
            </details>
          ) : (
            <StatusBadge tone="neutral" label={t('data.workspaceDeletion.ownerOnly')} />
          )}
        </Card>
      </SettingsSplit>
    </WorkspaceShell>
  );
}
