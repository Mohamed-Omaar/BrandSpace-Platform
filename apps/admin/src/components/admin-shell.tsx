import type { ReactNode } from 'react';
import {
  AppShell,
  BrandMark,
  BuildingIcon,
  FlagIcon,
  HomeIcon,
  KeyIcon,
  LanguageSwitcher,
  ProfileCard,
  TopbarActions,
  LayersIcon,
  LifebuoyIcon,
  ListIcon,
  PlugIcon,
  PulseIcon,
  RouteIcon,
  SlidersIcon,
  SparkIcon,
  StateMessage,
  StatusBadge,
  SupportModeBanner,
  colorTokens,
  menuItemStyle,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  type ShellNavSection,
  initialsFrom,
} from '@brandspace/ui';
import { translator, type MessageKey } from '../i18n/messages';

interface NavItem {
  readonly href: string;
  /** The navigation label. Short, because the rail is 250px wide. */
  readonly key: MessageKey;
  /** The top-bar page title. Longer, and centralised here so a
      layout-rendered shell can title pages it never sees. */
  readonly titleKey: MessageKey;
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
        titleKey: 'page.overview',
        permission: 'platform.workspace.read',
        icon: <HomeIcon size={20} />,
      },
      {
        href: '/workspaces',
        key: 'nav.workspaces',
        titleKey: 'page.workspaces',
        permission: 'platform.workspace.read',
        icon: <BuildingIcon size={20} />,
      },
      {
        href: '/support',
        key: 'nav.support',
        titleKey: 'page.support',
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
        titleKey: 'page.configuration',
        permission: 'platform.configuration.read',
        icon: <SlidersIcon size={20} />,
      },
      {
        href: '/secrets',
        key: 'nav.secrets',
        titleKey: 'page.secrets',
        permission: 'platform.secret.read',
        icon: <KeyIcon size={20} />,
      },
      {
        href: '/flags',
        key: 'nav.flags',
        titleKey: 'page.flags',
        permission: 'platform.configuration.read',
        icon: <FlagIcon size={20} />,
      },
      {
        href: '/plans',
        key: 'nav.plans',
        titleKey: 'page.plans',
        permission: 'platform.configuration.read',
        icon: <LayersIcon size={20} />,
      },
      {
        href: '/features',
        key: 'nav.features',
        titleKey: 'page.features',
        permission: 'platform.configuration.read',
        icon: <SlidersIcon size={20} />,
      },
    ],
  },
  {
    titleAr: 'الذكاء الاصطناعي والتكاملات',
    titleEn: 'AI & integrations',
    items: [
      {
        /*
         * Phase 10 — the Integrations Hub, FIRST in this section deliberately.
         * It is the one screen that answers "what is this platform connected
         * to"; the three below it are the detailed views of one slice each.
         */
        href: '/integrations',
        key: 'nav.integrations',
        titleKey: 'page.integrations',
        permission: 'platform.configuration.read',
        icon: <PlugIcon size={20} />,
      },
      {
        href: '/providers',
        key: 'nav.providers',
        titleKey: 'page.providers',
        permission: 'platform.configuration.read',
        icon: <LayersIcon size={20} />,
      },
      {
        href: '/ai-models',
        key: 'nav.aiRegistry',
        titleKey: 'page.aiRegistry',
        permission: 'platform.configuration.read',
        icon: <SparkIcon size={20} />,
      },
      {
        href: '/routing',
        key: 'nav.routing',
        titleKey: 'page.routing',
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
        titleKey: 'page.audit',
        permission: 'platform.audit.read',
        icon: <ListIcon size={20} />,
      },
      {
        href: '/ai-usage',
        key: 'nav.aiUsage',
        titleKey: 'page.aiUsage',
        // Its own authority, not "View any workspace": AI usage is a
        // per-workspace financial record (R-02's lesson).
        permission: 'platform.ai.usage.read',
        icon: <SparkIcon size={20} />,
      },
      {
        href: '/health',
        key: 'nav.health',
        titleKey: 'page.health',
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
        /*
         * `active` is left to the shell, which resolves it from the real
         * pathname by longest match.
         *
         * This comparison used to be `(activePath ?? '') === item.href`, and
         * the console LAYOUT never passed `activePath` — so the empty string
         * matched the console root's empty href and every one of the sixteen
         * console screens showed "Overview" as the current page. A layout
         * cannot read the pathname on the server; the shell is a client
         * component and can.
         */
        ...(activePath === undefined ? {} : { active: activePath === item.href }),
        /* The longer page title, for the top bar. The nav says "AI models";
           the page is "AI model registry". Both are true, and the reference
           puts the longer one in the bar. */
        pageTitle: t(item.titleKey),
        // The existing convention, preserved: the end-to-end suite selects
        // `nav-nav.configuration` and `nav-nav.secrets`.
        testId: `nav-${item.key}`,
      })),
  })).filter((section) => section.items.length > 0);

  return (
    <AppShell
      /* No subtitle in the rail: `.sidebar-top` is a fixed 42px, and
         "Platform administration" wrapped to a second line there, pushing every
         nav item down and out of alignment with the customer application. The
         same words are the top-bar eyebrow, where they have a full row. */
      brand={<BrandMark title={t('app.mark')} />}
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
            /*
             * A PRODUCTION BADGE KEEPS ITS OUTLINE. Everywhere else the border
             * came off with the rest of them, but this one is not decoration:
             * it is the signal that an action here is real, and it is the one
             * place where being visually louder than its neighbours is the
             * point. Non-production is a plain filled pill.
             */
            border: isProduction ? `1px solid ${colorTokens.danger}` : 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {environment}
        </span>
      }
      headerEnd={
        <TopbarActions
          labels={{
            search: t('topbar.search'),
            searchShortcut: t('topbar.searchShortcut'),
            notifications: t('topbar.notifications'),
            close: t('common.close'),
            previewTitle: t('topbar.previewTitle'),
            previewBody: t('topbar.previewBody'),
            create: t('topbar.create'),
          }}
          language={
            <LanguageSwitcher
              href={`/${other}/console${activePath ?? ''}`}
              targetLocale={other}
              targetLabel={other === 'ar' ? 'العربية' : 'English'}
              ariaLabel={t('nav.language')}
            />
          }
        />
      }
      /* The scope word above every console title — always, because the
         console LAYOUT renders the shell and never knows the page's own
         heading. Gating it on `heading` meant sixteen routes had a title with
         nothing above it and a top bar that read as half-empty. */
      pageEyebrow={t('app.subtitle')}
      pageTitle={heading}
      pageDescription={description}
      pageMeta={
        support ? (
          <StatusBadge
            label={locale === 'ar' ? 'وضع الدعم' : 'Support mode'}
            tone="accent"
            testId="support-mode-page-badge"
          />
        ) : undefined
      }
      profile={
        /* The same profile card the customer rail uses, with the operator's
           real identity and platform role. Sign-out lives in its menu. */
        <ProfileCard
          label={t('nav.account')}
          name={actorEmail}
          nameTestId="actor-identity"
          role={actorRole}
          initials={initialsFrom(actorEmail)}
        >
          <form action={`/${locale}/sign-out`} method="post">
            <button type="submit" role="menuitem" data-testid="sign-out" style={menuItemStyle()}>
              {t('nav.signOut')}
            </button>
          </form>
        </ProfileCard>
      }
    >
      {/*
        The title moved into the top bar (fidelity pass §4/§5), so the console
        gets the reference's single `eyebrow → h1 → actions` block rather than a
        strip followed by a detached heading. Page-level actions stay here.
      */}
      {actions ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.sm,
            marginBlockEnd: spacingTokens.md,
          }}
        >
          {actions}
        </div>
      ) : null}
      <div className="bs-section-stack">{children}</div>
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

export { DataTable, Cell } from '@brandspace/ui';

/**
 * The lead paragraph under a console page's title.
 *
 * REPLACES `PageHeading`, and the rename is the point. Every console page used
 * to render its own `<PageHeading title=… description=… />` one block below the
 * top bar, which is exactly the detached-heading composition the reference does
 * not have. The title now lives in the top bar, resolved from the route, so a
 * page that still tried to render one would produce a second `h1` — and a page
 * that quietly dropped its title would lose the authored copy.
 *
 * So the type changed rather than the behaviour being patched: `title` is gone,
 * TypeScript named all ten call sites, and each page's title moved to
 * `NAV_SECTIONS` beside its route where a layout-rendered shell can read it.
 */
export function PageIntro({ description }: { readonly description: string }) {
  return (
    <p
      data-testid="description"
      style={{
        margin: 0,
        maxInlineSize: '68ch',
        ...typographyTokens.bodySm,
        color: colorTokens.textSecondary,
      }}
    >
      {description}
    </p>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <StateMessage title={message} />;
}
