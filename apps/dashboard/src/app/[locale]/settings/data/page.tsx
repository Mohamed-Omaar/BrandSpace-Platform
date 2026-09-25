import Link from 'next/link';
import {
  Card,
  SectionHeader,
  SettingsSplit,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { inWorkspace, requireWorkspacePage } from '../../../../server/customer-context';
import { NoAccessPage } from '../../../../components/no-access-page';
import { brandContextFor } from '../../../../server/brand-context';
import { settingsNavItems } from '../../../../server/settings-nav';
import { translator, type MessageKey } from '../../../../i18n/messages';
import { WorkspaceShell } from '../../../../components/workspace-shell';

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
 * whole workspace and no self-serve workspace deletion today; `workspace.delete`
 * exists as a permission with no flow behind it. A data-controls page that
 * omitted them would let a customer assume the product had them — so each is
 * listed as "not available" with no invented process attached.
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): the same `SettingsSplit`, `Card`,
 * `SectionHeader` and `StatusBadge` the other Settings sections use.
 */
export default async function DataControlsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = translator(locale);
  const access = await requireWorkspacePage(locale, '/settings/data');
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;
  const may = (key: string) => workspace.permissionKeys.includes(key);

  const retentionDays = await inWorkspace(workspace.workspaceId, async ({ db }) => {
    const row = await db.workspace.findUniqueOrThrow({
      where: { id: workspace.workspaceId },
      select: { aiContentRetentionDays: true },
    });
    return row.aiContentRetentionDays;
  });

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
    { key: 'workspaceDeletion', available: false },
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
      </SettingsSplit>
    </WorkspaceShell>
  );
}
