import type { CSSProperties, ReactNode } from 'react';
import {
  AppShell,
  BrandMark,
  CreditIcon,
  HomeIcon,
  LanguageSwitcher,
  SettingsIcon,
  ShieldIcon,
  SignOutIcon,
  TeamIcon,
  WorkspaceSwitcher,
  Banner,
  PageHeader,
  StateMessage,
  buttonStyle,
  colorTokens,
  inputStyle,
  layoutTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  tdStyle,
  thStyle,
  type ShellNavSection,
  type WorkspaceOption,
} from '@brandspace/ui';
import { translator, type MessageKey } from '../i18n/messages';
import { signOutAction } from '../app/[locale]/(auth)/actions';

/**
 * The authenticated customer shell.
 *
 * Composes `AppShell` from the design system, so the sidebar, the drawer, the
 * collapse behaviour and the focus management are the SAME implementation the
 * Control Center uses. Before Phase 2C these were two hand-rolled flex rows
 * that had already drifted apart.
 *
 * Navigation is filtered by the member's EFFECTIVE permissions — which is a
 * convenience. Every page behind these links calls `requireWorkspace(locale,
 * permission)` and answers 404 without it, so removing a link is not what keeps
 * anyone out (docs/SECURITY.md §4.5).
 */
const NAV: readonly {
  href: string;
  key: MessageKey;
  permission: string | null;
  icon: ReactNode;
}[] = [
  { href: '/overview', key: 'nav.overview', permission: null, icon: <HomeIcon size={20} /> },
  { href: '/members', key: 'nav.members', permission: 'member.read', icon: <TeamIcon size={20} /> },
  { href: '/permissions', key: 'perms.title', permission: null, icon: <ShieldIcon size={20} /> },
  { href: '/plan', key: 'nav.plan', permission: 'billing.read', icon: <CreditIcon size={20} /> },
  {
    href: '/settings',
    key: 'nav.settings',
    permission: 'workspace.update',
    icon: <SettingsIcon size={20} />,
  },
];

export function WorkspaceShell({
  locale,
  heading,
  description,
  actions,
  meta,
  hero,
  activePath,
  workspaceName,
  roleName,
  permissionKeys,
  availableWorkspaces = [],
  children,
}: {
  locale: string;
  /**
   * The page title. THE SHELL OWNS THE `h1`, so every page has exactly one and
   * no page can forget it — which is what the accessibility suite asserts.
   */
  heading: string;
  description?: string | undefined;
  /** Page-level actions, rendered beside the title. */
  actions?: ReactNode;
  /** Badges or status pills that belong next to the title. */
  meta?: ReactNode;
  /**
   * A page that supplies its own title surface.
   *
   * The Overview's approved hero IS its page title (§5), so it renders the
   * `h1` itself and the standard header is suppressed rather than stacked
   * above it. Any page that passes `hero` is responsible for exactly one `h1`.
   */
  hero?: ReactNode;
  /**
   * The current path segment, e.g. `/members`. Marks the active nav item and
   * keeps the language switcher on the page the reader is actually on.
   */
  activePath?: string | undefined;
  workspaceName: string;
  roleName: string;
  permissionKeys: readonly string[];
  availableWorkspaces?: ReadonlyArray<{
    id: string;
    name: string;
    roleName: string;
    current: boolean;
  }>;
  children: ReactNode;
}) {
  const t = translator(locale);
  const other = locale === 'ar' ? 'en' : 'ar';

  const sections: readonly ShellNavSection[] = [
    {
      items: NAV.filter(
        (item) => item.permission === null || permissionKeys.includes(item.permission),
      ).map((item) => ({
        href: `/${locale}${item.href}`,
        label: t(item.key),
        icon: item.icon,
        active: activePath === item.href,
        // The existing convention, preserved: renaming these would drop the
        // end-to-end assertions that use them.
        testId: `nav-${item.href.slice(1)}`,
      })),
    },
  ];

  const workspaceOptions: readonly WorkspaceOption[] = availableWorkspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    roleName: workspace.roleName,
    href: `/${locale}/workspaces`,
    current: workspace.current,
  }));

  return (
    <AppShell
      brand={<BrandMark title={t('app.title')} />}
      sections={sections}
      labels={{
        primaryNavigation: t('nav.primary'),
        openNavigation: t('nav.open'),
        closeNavigation: t('nav.close'),
        collapseSidebar: t('nav.collapse'),
        expandSidebar: t('nav.expand'),
      }}
      headerStart={
        <WorkspaceSwitcher
          label={t('ws.switcherLabel')}
          current={{ name: workspaceName, roleName }}
          options={workspaceOptions}
          manageHref={`/${locale}/workspaces`}
          manageLabel={t('nav.switch')}
          manageTestId="switch-workspace"
        />
      }
      headerEnd={
        <LanguageSwitcher
          href={`/${other}${activePath ?? '/overview'}`}
          targetLocale={other}
          targetLabel={other === 'ar' ? 'العربية' : 'English'}
          ariaLabel={t('nav.language')}
        />
      }
      profile={
        /*
         * THE IDENTITY LIVES AT THE FOOT OF THE SIDEBAR (§6), not in the top
         * bar. The reference puts it there, and it is also where it belongs:
         * signing out is a rare action, and a header carrying brand, workspace,
         * language, notifications, account AND sign-out is the cluttered strip
         * §7 asks to avoid.
         */
        <form action={signOutAction} style={{ inlineSize: '100%', minInlineSize: 0 }}>
          <input type="hidden" name="locale" value={locale} />
          <button
            type="submit"
            data-testid="sign-out"
            className="bs-pressable bs-control"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: spacingTokens.sm,
              inlineSize: '100%',
              minInlineSize: 0,
              minBlockSize: layoutTokens.controlHeight,
              paddingInline: spacingTokens.sm,
              borderRadius: radiusTokens.md,
              border: '1px solid transparent',
              color: colorTokens.textSecondary,
              fontFamily: 'inherit',
              ...typographyTokens.bodySm,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <SignOutIcon size={18} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t('nav.signOut')}
            </span>
          </button>
        </form>
      }
    >
      {hero ?? (
        <PageHeader title={heading} description={description} actions={actions} meta={meta} />
      )}
      {children}
    </AppShell>
  );
}

/* -------------------------------------------------------------------------
 * PHASE 2C-B MIGRATION SURFACE.
 *
 * Phase 2C-A restyles a representative set of screens (§8.4) and deliberately
 * does NOT mechanically rewrite the rest — the point of the checkpoint is to
 * approve a direction before it is applied twenty times.
 *
 * These aliases keep the not-yet-migrated pages compiling AND make them inherit
 * the new tokens, because each one is now the design-system component wearing
 * its old name. They are a shim with a scheduled end, not an API: Phase 2C-B
 * replaces every call site and deletes this block.
 * ------------------------------------------------------------------------- */

export { Card as CustomerCard } from '@brandspace/ui';

export function CustomerEmpty({ message }: { message: string }) {
  return <StateMessage title={message} />;
}

export function CustomerBanner({
  tone,
  children,
}: {
  tone: 'success' | 'error';
  children: ReactNode;
}) {
  return <Banner tone={tone}>{children}</Banner>;
}

export const customerTableStyle = (): CSSProperties => ({
  inlineSize: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.875rem',
  textAlign: 'start',
});
export const customerThStyle = thStyle;
export const customerTdStyle = tdStyle;
export const customerButtonStyle = (): CSSProperties => buttonStyle('primary');
export const customerSecondaryButtonStyle = (): CSSProperties => buttonStyle('neutral');
export const customerInputStyle = (): CSSProperties => ({
  ...inputStyle(),
  maxInlineSize: '24rem',
});
