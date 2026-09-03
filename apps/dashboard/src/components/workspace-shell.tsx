import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { colorTokens, radiusTokens, shadowTokens, spacingTokens } from '@brandspace/ui';
import { translator, type MessageKey } from '../i18n/messages';
import { signOutAction } from '../app/[locale]/(auth)/actions';

/**
 * The authenticated customer shell.
 *
 * Navigation is filtered by the member's EFFECTIVE permissions — which is a
 * convenience. Every page behind these links calls `requireWorkspace(locale,
 * permission)` and returns 404 without it, so removing a link is not what keeps
 * anyone out (docs/SECURITY.md §4.5).
 */
const NAV: readonly { href: string; key: MessageKey; permission: string | null }[] = [
  { href: '/overview', key: 'nav.overview', permission: null },
  { href: '/members', key: 'nav.members', permission: 'member.read' },
  { href: '/permissions', key: 'perms.title', permission: null },
  { href: '/plan', key: 'nav.plan', permission: 'billing.read' },
  { href: '/settings', key: 'nav.settings', permission: 'workspace.update' },
];

export function WorkspaceShell({
  locale,
  heading,
  workspaceName,
  roleName,
  permissionKeys,
  children,
}: {
  locale: string;
  heading: string;
  workspaceName: string;
  roleName: string;
  permissionKeys: readonly string[];
  children: ReactNode;
}) {
  const t = translator(locale);
  const other = locale === 'ar' ? 'en' : 'ar';

  return (
    <div
      style={{
        minBlockSize: '100vh',
        background: colorTokens.appBackground,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          background: colorTokens.surface,
          borderBlockEnd: `1px solid ${colorTokens.border}`,
          padding: spacingTokens.md,
          display: 'flex',
          flexWrap: 'wrap',
          gap: spacingTokens.md,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <strong style={{ color: colorTokens.brandPurple }}>{t('app.title')}</strong>
          <span
            data-testid="active-workspace"
            style={{
              marginInlineStart: spacingTokens.sm,
              paddingInline: spacingTokens.sm,
              paddingBlock: '2px',
              borderRadius: radiusTokens.full,
              fontSize: '0.75rem',
              background: colorTokens.brandPurpleTint,
              color: colorTokens.brandPurple,
              border: `1px solid ${colorTokens.brandPurple}`,
            }}
          >
            {workspaceName}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            gap: spacingTokens.md,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span data-testid="active-role" style={{ color: colorTokens.textSecondary }}>
            {roleName}
          </span>
          <Link
            href={`/${locale}/workspaces`}
            data-testid="switch-workspace"
            style={{ color: colorTokens.brandPurple }}
          >
            {t('nav.switch')}
          </Link>
          <a href={`/${other}/overview`} data-testid="locale-switch" hrefLang={other}>
            {other === 'ar' ? 'العربية' : 'English'}
          </a>
          <form action={signOutAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" data-testid="sign-out" style={{ minBlockSize: '32px' }}>
              {t('nav.signOut')}
            </button>
          </form>
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, flexWrap: 'wrap' }}>
        <nav
          aria-label={locale === 'ar' ? 'تنقل مساحة العمل' : 'Workspace navigation'}
          style={{
            background: colorTokens.surface,
            padding: spacingTokens.md,
            borderInlineEnd: `1px solid ${colorTokens.border}`,
            flex: '1 1 13rem',
          }}
        >
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '4px' }}>
            {NAV.filter((i) => i.permission === null || permissionKeys.includes(i.permission)).map(
              (item) => (
                <li key={item.href}>
                  <Link
                    href={`/${locale}${item.href}`}
                    data-testid={`nav-${item.href.slice(1)}`}
                    // WCAG 2.2 target size (2.5.8): each link is its own
                    // 24x24 pointer target.
                    style={{
                      display: 'block',
                      minBlockSize: '24px',
                      paddingBlock: '6px',
                      paddingInline: spacingTokens.sm,
                      borderRadius: radiusTokens.md,
                    }}
                  >
                    {t(item.key)}
                  </Link>
                </li>
              ),
            )}
          </ul>
        </nav>

        <main
          id="main"
          style={{ flex: '999 1 22rem', padding: spacingTokens.lg, minInlineSize: 0 }}
        >
          <h1 style={{ marginBlockStart: 0, fontSize: '1.35rem' }}>{heading}</h1>
          {children}
        </main>
      </div>
    </div>
  );
}

export function CustomerCard({
  title,
  children,
  testId,
}: {
  title?: string | undefined;
  children: ReactNode;
  testId?: string | undefined;
}) {
  return (
    <section
      data-testid={testId}
      style={{
        background: colorTokens.surface,
        border: `1px solid ${colorTokens.cardBorder}`,
        borderRadius: radiusTokens.lg,
        boxShadow: shadowTokens.card,
        padding: spacingTokens.lg,
        marginBlockEnd: spacingTokens.lg,
      }}
    >
      {title && <h2 style={{ marginBlockStart: 0, fontSize: '1.05rem' }}>{title}</h2>}
      {children}
    </section>
  );
}

export function customerTableStyle(): CSSProperties {
  return {
    inlineSize: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.875rem',
    textAlign: 'start',
  };
}

export function customerThStyle(): CSSProperties {
  return {
    textAlign: 'start',
    padding: spacingTokens.sm,
    borderBlockEnd: `1px solid ${colorTokens.border}`,
    color: colorTokens.textSecondary,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
}

export function customerTdStyle(): CSSProperties {
  return {
    padding: spacingTokens.sm,
    borderBlockEnd: `1px solid ${colorTokens.cardBorder}`,
    verticalAlign: 'top',
  };
}

export function customerButtonStyle(): CSSProperties {
  return {
    minBlockSize: '36px',
    paddingInline: spacingTokens.md,
    paddingBlock: '8px',
    borderRadius: radiusTokens.md,
    background: colorTokens.brandPurple,
    color: colorTokens.brandPurpleInk,
    border: `1px solid ${colorTokens.brandPurple}`,
    fontSize: '0.875rem',
    cursor: 'pointer',
  };
}

export function customerSecondaryButtonStyle(): CSSProperties {
  return {
    minBlockSize: '36px',
    paddingInline: spacingTokens.md,
    paddingBlock: '8px',
    borderRadius: radiusTokens.md,
    background: colorTokens.surface,
    color: colorTokens.textPrimary,
    border: `1px solid ${colorTokens.border}`,
    fontSize: '0.875rem',
    cursor: 'pointer',
  };
}

export function customerInputStyle(): CSSProperties {
  return {
    inlineSize: '100%',
    maxInlineSize: '24rem',
    minBlockSize: '36px',
    paddingInline: spacingTokens.sm,
    paddingBlock: '6px',
    borderRadius: radiusTokens.md,
    border: `1px solid ${colorTokens.border}`,
    background: colorTokens.surface,
    color: colorTokens.textPrimary,
    fontFamily: 'inherit',
    fontSize: '0.875rem',
    boxSizing: 'border-box',
  };
}

/** Honest empty state. Never a fabricated figure. */
export function CustomerEmpty({ message }: { message: string }) {
  return (
    <p
      data-testid="empty-state"
      style={{
        margin: 0,
        padding: spacingTokens.md,
        background: colorTokens.appBackground,
        borderRadius: radiusTokens.md,
        color: colorTokens.textSecondary,
        fontSize: '0.875rem',
      }}
    >
      {message}
    </p>
  );
}

export function CustomerBanner({
  tone,
  children,
}: {
  tone: 'success' | 'error';
  children: ReactNode;
}) {
  const success = tone === 'success';
  return (
    <p
      role="status"
      data-testid={success ? 'success-banner' : 'error-banner'}
      style={{
        margin: 0,
        marginBlockEnd: spacingTokens.md,
        padding: spacingTokens.sm,
        borderRadius: radiusTokens.md,
        fontSize: '0.875rem',
        background: success ? '#ECFDF3' : '#FEF3F2',
        color: success ? colorTokens.success : colorTokens.danger,
        borderInlineStart: `3px solid ${success ? colorTokens.success : colorTokens.danger}`,
      }}
    >
      {children}
    </p>
  );
}
