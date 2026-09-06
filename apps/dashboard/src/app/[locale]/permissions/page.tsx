import { ALL_PERMISSIONS } from '@brandspace/shared';
import { colorTokens, scrollContainerStyle, typographyTokens } from '@brandspace/ui';
import { requireWorkspace } from '../../../server/customer-context';
import { translator } from '../../../i18n/messages';
import {
  CustomerCard,
  WorkspaceShell,
  customerTableStyle,
  customerTdStyle,
  customerThStyle,
} from '../../../components/workspace-shell';

export const dynamic = 'force-dynamic';

/**
 * Roles and permissions, as the member actually holds them.
 *
 * Rendered from the EFFECTIVE permission set resolved for this session, not
 * from a static description of the role. If the two ever disagree, this page
 * shows the truth — which is the point of having it.
 */
export default async function PermissionsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = translator(locale);
  const { workspace } = await requireWorkspace(locale);

  const workspacePermissions = ALL_PERMISSIONS.filter((p) => p.minScope !== 'platform');

  return (
    <WorkspaceShell
      locale={locale}
      heading={t('perms.title')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      permissionKeys={workspace.permissionKeys}
    >
      <CustomerCard testId="permissions-card">
        <p style={{ marginBlockStart: 0 }}>
          <strong>{t('perms.yourRole')}:</strong>{' '}
          <span data-testid="your-role">
            {locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
          </span>
        </p>

        <div style={scrollContainerStyle()}>
          <table style={customerTableStyle()} data-testid="permissions-table">
            <thead>
              <tr>
                <th style={customerThStyle()}>{t('perms.permission')}</th>
                <th style={customerThStyle()}>{t('members.status')}</th>
              </tr>
            </thead>
            <tbody>
              {workspacePermissions.map((p) => {
                const held = workspace.permissionKeys.includes(p.key);
                return (
                  <tr key={p.key} data-testid={`permission-${p.key}`}>
                    <td style={customerTdStyle()}>
                      <code>{p.key}</code>
                      <br />
                      <span style={{ color: colorTokens.textSecondary, ...typographyTokens.label }}>
                        {p.description}
                      </span>
                    </td>
                    <td style={customerTdStyle()}>
                      <span data-testid={`permission-state-${p.key}`}>
                        {held ? t('common.enabled') : t('common.disabled')}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CustomerCard>
    </WorkspaceShell>
  );
}
