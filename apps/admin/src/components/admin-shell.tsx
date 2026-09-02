import type { ReactNode } from 'react';
import Link from 'next/link';
import { colorTokens, spacingTokens } from '@brandspace/ui';
import { translator, type MessageKey } from '../i18n/messages';

/** Console navigation. Each entry names the permission that gates its page. */
const NAV: readonly { href: string; key: MessageKey; permission: string }[] = [
  { href: '', key: 'nav.overview', permission: 'platform.workspace.read' },
  { href: '/configuration', key: 'nav.configuration', permission: 'platform.workspace.read' },
  { href: '/secrets', key: 'nav.secrets', permission: 'platform.workspace.read' },
  { href: '/providers', key: 'nav.providers', permission: 'platform.workspace.read' },
  { href: '/ai-models', key: 'nav.aiRegistry', permission: 'platform.workspace.read' },
  { href: '/routing', key: 'nav.routing', permission: 'platform.workspace.read' },
  { href: '/flags', key: 'nav.flags', permission: 'platform.workspace.read' },
  { href: '/plans', key: 'nav.plans', permission: 'platform.workspace.read' },
  { href: '/audit', key: 'nav.audit', permission: 'platform.audit.read' },
  { href: '/health', key: 'nav.health', permission: 'platform.workspace.read' },
];

export function AdminShell({
  locale,
  actorEmail,
  actorRole,
  permissionKeys,
  environment,
  children,
}: {
  locale: string;
  actorEmail: string;
  actorRole: string;
  permissionKeys: readonly string[];
  environment: string;
  children: ReactNode;
}) {
  const t = translator(locale);
  const other = locale === 'ar' ? 'en' : 'ar';
  const isProduction = environment === 'PRODUCTION';

  return (
    <div style={{ minBlockSize: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
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
          <strong style={{ color: colorTokens.brandBlueText }}>{t('app.title')}</strong>
          {/* The active environment is always visible: production actions must
              never be taken by accident. */}
          <span
            data-testid="environment-badge"
            style={{
              marginInlineStart: spacingTokens.sm,
              padding: `2px ${spacingTokens.sm}`,
              borderRadius: '999px',
              fontSize: '0.75rem',
              background: isProduction ? colorTokens.danger : colorTokens.surfaceMuted,
              color: isProduction ? '#FFFFFF' : colorTokens.textSecondary,
              border: `1px solid ${isProduction ? colorTokens.danger : colorTokens.border}`,
            }}
          >
            {environment}
          </span>
        </div>
        <div style={{ display: 'flex', gap: spacingTokens.md, alignItems: 'center' }}>
          <span data-testid="actor-identity" style={{ color: colorTokens.textSecondary }}>
            {actorEmail} · {actorRole}
          </span>
          <a href={`/${other}`} data-testid="locale-switch" hrefLang={other}>
            {other === 'ar' ? 'العربية' : 'English'}
          </a>
          <form action={`/${locale}/sign-out`} method="post">
            <button type="submit" data-testid="sign-out">
              {t('nav.signOut')}
            </button>
          </form>
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, flexWrap: 'wrap' }}>
        <nav
          aria-label={t('app.subtitle')}
          // `flex-basis` rather than a minimum width: below roughly 34rem the
          // navigation and the content cannot both fit, and the pair wraps onto
          // separate rows instead of squeezing the content until it overflows
          // the viewport. Logical properties throughout, so RTL behaves the same.
          style={{
            padding: spacingTokens.md,
            borderInlineEnd: `1px solid ${colorTokens.border}`,
            flex: '1 1 14rem',
          }}
        >
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: spacingTokens.xs,
            }}
          >
            {NAV.filter((item) => permissionKeys.includes(item.permission)).map((item) => (
              <li key={item.key}>
                <Link
                  href={`/${locale}/console${item.href}`}
                  data-testid={`nav-${item.key}`}
                  // WCAG 2.2 AA target size (2.5.8): each link is its own
                  // pointer target of at least 24x24 CSS pixels. A bare inline
                  // link in a tight list fails this on touch, which the
                  // accessibility suite caught.
                  style={{
                    display: 'block',
                    minBlockSize: '24px',
                    paddingBlock: '6px',
                    paddingInline: spacingTokens.sm,
                    borderRadius: '0.375rem',
                  }}
                >
                  {t(item.key)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* A large grow factor keeps the content column dominant once both fit
            on one row; the 20rem basis is what makes them wrap before that. */}
        <main
          id="main"
          style={{ flex: '999 1 20rem', padding: spacingTokens.lg, minInlineSize: 0 }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/** Page heading. Exactly one h1 per page — asserted by the a11y suite. */
export function PageHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div style={{ marginBlockEnd: spacingTokens.lg }}>
      <h1
        style={{ color: colorTokens.brandBlueText, marginBlockEnd: spacingTokens.xs }}
        data-testid="heading"
      >
        {title}
      </h1>
      {description ? (
        <p style={{ color: colorTokens.textSecondary, margin: 0 }} data-testid="description">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/** Table that scrolls inside its own container rather than the page. */
export function DataTable({
  headers,
  children,
}: {
  headers: readonly string[];
  children: ReactNode;
}) {
  return (
    <div
      // A region that scrolls with the mouse must also scroll with the keyboard,
      // or its content is unreachable without a pointer (WCAG 2.1.1). Making the
      // container focusable is the remedy; the accessibility suite caught this
      // the moment a table grew wide enough to actually overflow.
      tabIndex={0}
      style={{
        overflowX: 'auto',
        border: `1px solid ${colorTokens.border}`,
        borderRadius: '0.5rem',
      }}
    >
      <table style={{ inlineSize: '100%', borderCollapse: 'collapse', minInlineSize: '32rem' }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                scope="col"
                style={{
                  textAlign: 'start',
                  padding: spacingTokens.sm,
                  borderBlockEnd: `1px solid ${colorTokens.border}`,
                  background: colorTokens.surfaceMuted,
                  fontSize: '0.875rem',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children }: { children: ReactNode }) {
  return (
    <td style={{ padding: spacingTokens.sm, borderBlockEnd: `1px solid ${colorTokens.border}` }}>
      {children}
    </td>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <p data-testid="empty-state" style={{ color: colorTokens.textSecondary }}>
      {message}
    </p>
  );
}
