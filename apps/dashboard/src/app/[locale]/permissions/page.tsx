import { ALL_PERMISSIONS, ROLE_DEFINITIONS } from '@brandspace/shared';
import {
  ContentGrid,
  SectionHeader,
  ShieldIcon,
  StatusBadge,
  colorTokens,
  radiusTokens,
  scrollContainerStyle,
  shadowTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor } from '../../../server/brand-context';
import { OWNER_ONLY_PERMISSIONS, optionalMessage, translator } from '../../../i18n/messages';
import { permissionGroups } from '../../../server/permission-groups';
import { PermissionGroupsList } from '../../../components/permission-groups-view';
import { SettingsFrame } from '../../../components/settings-frame';
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
  const { customer, workspace, messageLocale } = await requireWorkspace(locale);
  const t = translator(messageLocale);

  const workspacePermissions = ALL_PERMISSIONS.filter((p) => p.minScope !== 'platform');

  /*
   * The workspace's ROLES, as a card grid — the demo's composition for this
   * screen (`.feature-matrix { grid-template-columns: repeat(3,1fr) }` with a
   * `.phase-badge` per card). Real definitions from `ROLE_DEFINITIONS` and
   * real permission counts; nothing is invented and nothing tenant-owned is
   * exposed, because a role definition is the same for every workspace.
   *
   * It does NOT replace the table below it. The demo's screen answers "what
   * roles exist"; the table answers "what can I, in this session, actually
   * do" — resolved from the effective permission set rather than from a
   * description of the role, which is the whole point of having it.
   */
  const roles = ROLE_DEFINITIONS.filter((role) => role.realm === 'workspace');

  const brandContext = await brandContextFor(workspace, '/permissions');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('nav.settings')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <SettingsFrame
        brandSource={workspace}
        locale={locale}
        permissionKeys={workspace.permissionKeys}
        selected="permissions"
      >
        <SectionHeader
          eyebrow={t('perms.eyebrow')}
          title={t('perms.rolesTitle')}
          description={t('settings.p.subtitle')}
        />
        <div style={{ marginBlockEnd: spacingTokens.md }}>
          <ContentGrid min="15rem" testId="role-grid">
            {roles.map((role) => {
              const mine = role.key === workspace.roleKey;
              return (
                <div
                  key={role.key}
                  data-testid={`role-${role.key}`}
                  /*
                  `.feature-card { min-height: 190px; padding: 19px;
                   border-radius: 19px; background: rgba(255,255,255,.78);
                   box-shadow: var(--soft-shadow) }` with
                  `h3 { font-size: 15px; margin: 22px 0 7px }` over a 9px
                  description and a `.phase-badge`.
                */
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    minBlockSize: '11.875rem',
                    padding: '1.1875rem',
                    borderRadius: radiusTokens['2xl'],
                    background: colorTokens.surfaceCardAlpha,
                    boxShadow: shadowTokens.card,
                    minInlineSize: 0,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-grid',
                      placeItems: 'center',
                      inlineSize: '2.625rem',
                      blockSize: '2.625rem',
                      borderRadius: radiusTokens.control,
                      background: mine
                        ? colorTokens.surfaceLavenderStrong
                        : colorTokens.surfaceMuted,
                      color: mine ? colorTokens.brandPurplePressed : colorTokens.textMuted,
                    }}
                  >
                    <ShieldIcon size={17} />
                  </span>
                  <h3
                    style={{
                      margin: `${spacingTokens.md} 0 ${spacingTokens['3xs']}`,
                      ...typographyTokens.cardTitle,
                      color: colorTokens.textPrimary,
                    }}
                  >
                    {locale === 'ar' ? role.nameAr : role.nameEn}
                  </h3>
                  <p
                    style={{
                      margin: 0,
                      ...typographyTokens.caption,
                      lineHeight: 1.55,
                      color: colorTokens.textMuted,
                    }}
                  >
                    {role.permissionKeys.length === 1
                      ? t('perms.permissionCountOne')
                      : t('perms.permissionCount').replace(
                          '{count}',
                          String(role.permissionKeys.length),
                        )}
                  </p>
                  <div style={{ marginBlockStart: 'auto', paddingBlockStart: spacingTokens.sm }}>
                    {mine ? (
                      <StatusBadge label={t('perms.yourRole')} tone="accent" testId="role-mine" />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </ContentGrid>
        </div>

        <div
          data-testid="permissions-card"
          style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
        >
          <p style={{ margin: 0 }}>
            <strong>{t('perms.yourRole')}:</strong>{' '}
            <span data-testid="your-role">
              {locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
            </span>
          </p>

          {/*
            Round 4, 2.1 — the prototype's grouped view (`T.groups`): the
            role's permissions as plain-language actions in seven groups. No
            permission key is rendered; the key is only the row's identity.
          */}
          <PermissionGroupsList
            groups={permissionGroups(workspace.permissionKeys, OWNER_ONLY_PERMISSIONS)}
            t={t}
            testId="perm-groups"
          />

          {/*
            Every workspace permission, the ones the groups do not name
            included, behind the existing "All permissions" disclosure —
            listed by what it lets you do, never by its key. Still the
            effective set for this session (E6/Q4: no per-member override).
          */}
          <details className="bsp-pg-more">
            <summary className="bsp-btn bsp-ghost bsp-sm" data-testid="permissions-all">
              {t('perms.allPermissions')}
            </summary>
            <CustomerCard>
              <div
                style={scrollContainerStyle()}
                tabIndex={0}
                role="group"
                aria-label={t('perms.permission')}
              >
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
                            {/* P6-14 — the catalogue's description is English only; the
                            dictionary carries both, and the catalogue is the fallback. */}
                            {optionalMessage(messageLocale, `perms.desc.${p.key}`) ?? p.description}
                          </td>
                          <td style={customerTdStyle()}>
                            <span data-testid={`permission-state-${p.key}`}>
                              {held ? t('common.enabled') : t('common.disabled')}
                            </span>
                            {/* E6/Q4 — no per-member override exists: every row is the
                            role's, and says so rather than looking editable. */}
                            <br />
                            <span
                              data-testid={`permission-source-${p.key}`}
                              style={{
                                color: colorTokens.textSecondary,
                                ...typographyTokens.label,
                              }}
                            >
                              {t('perms.fromRole')}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CustomerCard>
          </details>
          <p
            className="bsp-pg-audit"
            style={{ marginBlockEnd: 0 }}
            data-testid="permissions-logged"
          >
            {t('perms.logged')}
          </p>
        </div>
      </SettingsFrame>
    </WorkspaceShell>
  );
}
