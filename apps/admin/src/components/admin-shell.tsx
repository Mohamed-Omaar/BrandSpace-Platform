import type { ReactNode } from 'react';
import {
  AppShell,
  BrandMark,
  BuildingIcon,
  FlagIcon,
  HomeIcon,
  KeyIcon,
  LanguageSwitcher,
  LayersIcon,
  LifebuoyIcon,
  ListIcon,
  PageHeader,
  PulseIcon,
  RouteIcon,
  SlidersIcon,
  SparkIcon,
  StateMessage,
  StatusBadge,
  SupportModeBanner,
  buttonStyle,
  colorTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  type ShellNavSection,
} from '@brandspace/ui';
import { translator, type MessageKey } from '../i18n/messages';

interface NavItem {
  readonly href: string;
  readonly key: MessageKey;
  readonly permission: string;
  readonly icon: ReactNode;
}

/**
 * Console navigation, grouped into functional sections.
 *
 * Each entry names the permission that gates its page. Filtering by permission
 * here is a CONVENIENCE — the page itself calls `requirePageActor` and returns
 * 404 without the permission. Hiding a link is not authorization.
 *
 * A section with no visible item is not rendered, so a support agent does not
 * see an empty "Configuration" heading and wonder what is missing.
 */
const NAV_SECTIONS: ReadonlyArray<{
  readonly titleAr: string;
  readonly titleEn: string;
  readonly items: readonly NavItem[];
}> = [
  {
    titleAr: 'العملاء',
    titleEn: 'Customers',
    items: [
      {
        href: '',
        key: 'nav.overview',
        permission: 'platform.workspace.read',
        icon: <HomeIcon size={20} />,
      },
      {
        href: '/workspaces',
        key: 'nav.workspaces',
        permission: 'platform.workspace.read',
        icon: <BuildingIcon size={20} />,
      },
      {
        href: '/support',
        key: 'nav.support',
        permission: 'platform.support_mode.enter',
        icon: <LifebuoyIcon size={20} />,
      },
    ],
  },
  {
    titleAr: 'المنصة',
    titleEn: 'Platform',
    items: [
      {
        href: '/configuration',
        key: 'nav.configuration',
        permission: 'platform.configuration.read',
        icon: <SlidersIcon size={20} />,
      },
      {
        href: '/secrets',
        key: 'nav.secrets',
        permission: 'platform.secret.read',
        icon: <KeyIcon size={20} />,
      },
      {
        href: '/flags',
        key: 'nav.flags',
        permission: 'platform.configuration.read',
        icon: <FlagIcon size={20} />,
      },
      {
        href: '/plans',
        key: 'nav.plans',
        permission: 'platform.configuration.read',
        icon: <LayersIcon size={20} />,
      },
    ],
  },
  {
    titleAr: 'الذكاء الاصطناعي والتكاملات',
    titleEn: 'AI & integrations',
    items: [
      {
        href: '/providers',
        key: 'nav.providers',
        permission: 'platform.configuration.read',
        icon: <LayersIcon size={20} />,
      },
      {
        href: '/ai-models',
        key: 'nav.aiRegistry',
        permission: 'platform.configuration.read',
        icon: <SparkIcon size={20} />,
      },
      {
        href: '/routing',
        key: 'nav.routing',
        permission: 'platform.configuration.read',
        icon: <RouteIcon size={20} />,
      },
    ],
  },
  {
    titleAr: 'العمليات',
    titleEn: 'Operations',
    items: [
      {
        href: '/audit',
        key: 'nav.audit',
        permission: 'platform.audit.read',
        icon: <ListIcon size={20} />,
      },
      {
        href: '/health',
        key: 'nav.health',
        permission: 'platform.workspace.read',
        icon: <PulseIcon size={20} />,
      },
    ],
  },
];

/** The active Support Mode grant, resolved server-side by the console layout. */
export interface SupportBannerState {
  readonly workspaceName: string;
  readonly reason: string;
  readonly remainingMinutes: number;
}

export function AdminShell({
  locale,
  heading,
  description,
  actions,
  activePath,
  actorEmail,
  actorRole,
  permissionKeys,
  environment,
  support = null,
  children,
}: {
  locale: string;
  /**
   * Optional page title.
   *
   * The console layout wraps EVERY page, and a layout cannot know the title of
   * the page inside it — so here the page keeps ownership of its own `h1` via
   * `PageHeading`, and this prop exists for the pages that let the shell render
   * it. Exactly one of the two renders a heading, never both.
   */
  heading?: string | undefined;
  description?: string | undefined;
  actions?: ReactNode;
  /** Path after `/console`, e.g. `/workspaces`. Marks the active nav item. */
  activePath?: string | undefined;
  actorEmail: string;
  actorRole: string;
  permissionKeys: readonly string[];
  environment: string;
  support?: SupportBannerState | null;
  children: ReactNode;
}) {
  const t = translator(locale);
  const other = locale === 'ar' ? 'en' : 'ar';
  const isProduction = environment === 'PRODUCTION';

  const sections: readonly ShellNavSection[] = NAV_SECTIONS.map((section) => ({
    title: locale === 'ar' ? section.titleAr : section.titleEn,
    items: section.items
      .filter((item) => permissionKeys.includes(item.permission))
      .map((item) => ({
        href: `/${locale}/console${item.href}`,
        label: t(item.key),
        icon: item.icon,
        active: (activePath ?? '') === item.href,
        // The existing convention, preserved: the end-to-end suite selects
        // `nav-nav.configuration` and `nav-nav.secrets`.
        testId: `nav-${item.key}`,
      })),
  })).filter((section) => section.items.length > 0);

  return (
    <AppShell
      brand={<BrandMark title={t('app.title')} subtitle={t('app.subtitle')} />}
      sections={sections}
      labels={{
        primaryNavigation: t('nav.primary'),
        openNavigation: t('nav.open'),
        closeNavigation: t('nav.close'),
        collapseSidebar: t('nav.collapse'),
        expandSidebar: t('nav.expand'),
      }}
      banner={
        support ? (
          /*
            Support Mode banner. Persistent, unmistakable, and above everything
            — docs/SECURITY.md §8. It is sticky, so it cannot be scrolled away,
            and the text says plainly that this is platform staff and NOT the
            customer: D-28 prohibits impersonation, and an ambiguous banner
            weakens that as surely as a missing check would.
          */
          <SupportModeBanner
            text={
              locale === 'ar'
                ? 'وضع الدعم — قراءة فقط · أنت موظف منصة ولستَ العميل'
                : 'SUPPORT MODE — read only · you are platform staff, not the customer'
            }
            detail={
              locale === 'ar'
                ? `${support.workspaceName} · تبقّى ${support.remainingMinutes} دقيقة`
                : `${support.workspaceName} · ${support.remainingMinutes} min left`
            }
          />
        ) : undefined
      }
      headerStart={
        /* The active environment is always visible: production actions must
           never be taken by accident. */
        <span
          data-testid="environment-badge"
          style={{
            paddingInline: spacingTokens.sm,
            paddingBlock: '2px',
            borderRadius: radiusTokens.full,
            ...typographyTokens.caption,
            fontWeight: 700,
            background: isProduction ? colorTokens.danger : colorTokens.surfaceMuted,
            color: isProduction ? colorTokens.textInverse : colorTokens.textSecondary,
            border: `1px solid ${isProduction ? colorTokens.danger : colorTokens.border}`,
            whiteSpace: 'nowrap',
          }}
        >
          {environment}
        </span>
      }
      headerEnd={
        <>
          <span
            data-testid="actor-identity"
            style={{
              ...typographyTokens.caption,
              color: colorTokens.textSecondary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxInlineSize: '16rem',
            }}
          >
            {actorEmail} · {actorRole}
          </span>
          <LanguageSwitcher
            href={`/${other}/console${activePath ?? ''}`}
            targetLocale={other}
            targetLabel={other === 'ar' ? 'العربية' : 'English'}
            ariaLabel={t('nav.language')}
          />
          <form action={`/${locale}/sign-out`} method="post">
            <button type="submit" data-testid="sign-out" style={buttonStyle('secondary', 'sm')}>
              {t('nav.signOut')}
            </button>
          </form>
        </>
      }
    >
      {heading ? (
        <PageHeader
          title={heading}
          description={description}
          actions={actions}
          meta={
            support ? (
              <StatusBadge
                label={locale === 'ar' ? 'وضع الدعم' : 'Support mode'}
                tone="accent"
                testId="support-mode-page-badge"
              />
            ) : undefined
          }
        />
      ) : null}
      {children}
    </AppShell>
  );
}

/* -------------------------------------------------------------------------
 * PHASE 2C-B MIGRATION SURFACE.
 *
 * Phase 2C-A restyles a representative set of console screens (§8.4). These
 * aliases keep the remaining pages compiling and make them inherit the new
 * tokens, because each is the design-system component under its previous name.
 * Phase 2C-B replaces the call sites and deletes this block.
 * ------------------------------------------------------------------------- */

export { PageHeader as PageHeading, DataTable, Cell } from '@brandspace/ui';

export function EmptyState({ message }: { message: string }) {
  return <StateMessage title={message} />;
}
