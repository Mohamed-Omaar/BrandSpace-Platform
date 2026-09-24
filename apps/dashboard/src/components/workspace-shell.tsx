import Link from 'next/link';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import {
  AppShell,
  BrandMark,
  ProfileCard,
  TopbarCreateMenu,
  TopbarLink,
  menuItemStyle,
  HomeIcon,
  CalendarIcon,
  FlagIcon,
  LayersIcon,
  ImageIcon,
  PencilIcon,
  PulseIcon,
  RouteIcon,
  SlidersIcon,
  LanguageSwitcher,
  SendIcon,
  SettingsIcon,
  SparkIcon,
  BrandCard,
  BrandSwitcher,
  Banner,
  StateMessage,
  spacingTokens,
  type ShellNavSection,
  type Tone,
  initialsFrom,
} from '@brandspace/ui';
import { switchLocalePath } from '../i18n/locale-path';
import { translator, type MessageKey } from '../i18n/messages';
import type { BrandContext } from '../server/brand-context';
import { topbarModel } from '../server/topbar';
import { copilotSurfaceForPath } from '../server/copilot-surface';
import { copilotLabels } from '../server/copilot-labels';
import { copilotDrawerSubject } from '../server/copilot-context';
import { GlobalCopilot } from './global-copilot';
import { NotificationsBell } from './notifications-bell';
import { loadNotificationFeed } from '../app/[locale]/notifications/feed';
import { SETTINGS_PATHS, settingsLandingPath } from '../server/settings-nav';
import { topbarCounts } from '../server/topbar-counts';
import { getCustomerAuth, getSessionToken } from '../server/customer-context';
import { selectBrandAction } from '../app/[locale]/brand-context-actions';

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
interface NavEntry {
  href: string;
  key: MessageKey;
  permission: string | null;
  icon: ReactNode;
}

/**
 * The rail's groups, in the order of the work (P6-04).
 *
 * WHY THIS IS A DATA CHANGE AND NOT A COMPONENT ONE. `AppShell` has always
 * taken `readonly ShellNavSection[]` with an optional per-section `title`, has
 * always rendered those titles as `.nav-group-title`, and already replaces a
 * heading with a divider when the rail is collapsed — the Control Center has
 * used all of it since Phase 2C. The customer dashboard passed twenty-one
 * entries as ONE unnamed section, so a member arriving at a workspace met an
 * undifferentiated list and had to know the product to find anything in it.
 *
 * Nothing about the sidebar's appearance changes: same geometry, same density,
 * same icons, same active treatment, same collapse behaviour. What changes is
 * that the list says what its parts are for.
 *
 * THE ORDER IS THE ORDER OF THE WORK: know the brand, plan it, make it, publish
 * it, learn from it, automate it — and the workspace's own administration last,
 * because administering the workspace is not the work.
 *
 * EVERY PERMISSION GATE IS CARRIED OVER UNCHANGED. Grouping must not become a
 * way to leak an entry: each route still calls `requireWorkspace(locale,
 * permission)` and answers 404 without it, the hidden link is still tidiness
 * rather than security, and a group whose every entry is filtered out renders
 * no heading at all — a titled group with nothing under it would be the dead
 * navigation §20 forbids, wearing a label.
 */
const NAV: readonly NavEntry[] = [
  { href: '/overview', key: 'nav.overview', permission: null, icon: <HomeIcon size={20} /> },
  {
    href: '/brand-brain',
    key: 'nav.brandBrain',
    permission: 'brand_brain.read',
    icon: <SparkIcon size={20} />,
  },
  {
    href: '/strategy',
    key: 'nav.strategy',
    permission: 'strategy.read',
    icon: <RouteIcon size={20} />,
  },
  {
    href: '/campaigns',
    key: 'nav.campaigns',
    permission: 'campaigns.read',
    // `FlagIcon` reused rather than a new glyph drawn (§4.2 rule 4): a campaign
    // is a marker planted on a period of work, which is what a flag is.
    icon: <FlagIcon size={20} />,
  },
  {
    href: '/content',
    key: 'nav.content',
    permission: 'content.read',
    icon: <PencilIcon size={20} />,
  },
  {
    href: '/creative',
    key: 'nav.creative',
    permission: 'assets.upload',
    // `SparkIcon` reused rather than a new glyph drawn (§4.2 rule 4): it is the
    // product's mark for "a model did this", and it is what Brand Brain wears.
    icon: <SparkIcon size={20} />,
  },
  {
    href: '/assets',
    key: 'nav.assets',
    permission: 'assets.read',
    icon: <ImageIcon size={20} />,
  },
  {
    href: '/calendar',
    key: 'nav.calendar',
    permission: 'content.read',
    icon: <CalendarIcon size={20} />,
  },
  /*
   * PUBLISHING (D-277 §33): Queue · Published · Failed · Accounts. Gated on
   * `publishing.read`, exactly as the route is. `SendIcon` reused: publishing
   * IS sending.
   */
  {
    href: '/publishing',
    key: 'nav.publishing',
    permission: 'publishing.read',
    icon: <SendIcon size={20} />,
  },
  {
    href: '/analytics',
    key: 'nav.analytics',
    permission: 'analytics.read',
    icon: <PulseIcon size={20} />,
  },
  {
    href: '/intelligence',
    key: 'nav.intelligence',
    permission: 'strategy.read',
    icon: <LayersIcon size={20} />,
  },
  {
    href: '/automations',
    key: 'nav.automations',
    permission: 'automation.read',
    icon: <SlidersIcon size={20} />,
  },
  /*
   * SETTINGS is for EVERY member: it holds Security, Roles & permissions and
   * Activity, which ask no permission. Its href is resolved per member to the
   * first section they may open (`settingsLandingPath`), so it never 404s.
   */
  {
    href: '/settings',
    key: 'nav.settings',
    permission: null,
    icon: <SettingsIcon size={20} />,
  },
];

/*
 * THE FINAL INFORMATION ARCHITECTURE (owner decision D-277, contract §3).
 *
 * Home, then the selected brand's Brand Brain — its group is TITLED WITH THE
 * BRAND, so the rail itself says whose brain it is — then the work in order:
 * PLAN, CREATE, PUBLISH, IMPROVE, AUTOMATE, and Settings last.
 *
 * NOT ON THE RAIL, AND WHERE THEY WENT: Approvals (top-bar Review, Home, the
 * post and campaign screens), Notes (top-bar Notes, Home, the object itself),
 * Notifications (the bell), Copilot (the top bar), Team, Roles & permissions,
 * Activity, Plan, Billing and Connections (Settings), Onboarding (the first-run
 * wizard). Every one of those routes still exists and still authorizes itself.
 */
const NAV_GROUPS: readonly { titleKey: MessageKey | null; hrefs: readonly string[] }[] = [
  { titleKey: null, hrefs: ['/overview'] },
  { titleKey: 'nav.group.brand', hrefs: ['/brand-brain'] },
  { titleKey: 'nav.group.plan', hrefs: ['/strategy', '/campaigns'] },
  { titleKey: 'nav.group.create', hrefs: ['/content', '/creative', '/assets'] },
  { titleKey: 'nav.group.publish', hrefs: ['/calendar', '/publishing'] },
  { titleKey: 'nav.group.improve', hrefs: ['/analytics', '/intelligence'] },
  { titleKey: 'nav.group.automate', hrefs: ['/automations'] },
  { titleKey: null, hrefs: ['/settings'] },
];

function navSections(
  permissionKeys: readonly string[],
  locale: string,
  activePath: string | undefined,
  t: (key: MessageKey) => string,
  brandContext: BrandContext | undefined,
): readonly ShellNavSection[] {
  const byHref = new Map(NAV.map((item) => [item.href, item]));
  const placed = NAV_GROUPS.flatMap((group) => group.hrefs);
  if (placed.length !== NAV.length || new Set(placed).size !== NAV.length) {
    // A programming error, not a runtime condition: it can only be reached by
    // editing NAV or NAV_GROUPS and not the other.
    throw new Error('Every NAV entry must appear in exactly one NAV_GROUPS entry.');
  }

  const sections: ShellNavSection[] = [];
  for (const group of NAV_GROUPS) {
    const items = group.hrefs
      .map((href) => byHref.get(href))
      .filter((item): item is NavEntry => item !== undefined)
      .filter((item) => item.permission === null || permissionKeys.includes(item.permission))
      .map((item) => ({
        href:
          item.href === '/settings'
            ? `/${locale}${settingsLandingPath(permissionKeys)}`
            : `/${locale}${item.href}`,
        label: t(item.key),
        icon: item.icon,
        active:
          activePath === item.href ||
          (item.href === '/settings' &&
            activePath !== undefined &&
            SETTINGS_PATHS.includes(activePath)),
        // The existing convention, preserved: renaming these would drop the
        // end-to-end assertions that use them.
        testId: `nav-${item.href.slice(1)}`,
      }));
    if (items.length === 0) continue;
    /*
     * THE BRAND GROUP IS TITLED WITH THE BRAND (§3: "visually associated with
     * the currently selected Brand"). "All brands" when that is the selection;
     * the generic word only when there is no brand to name.
     */
    const title =
      group.titleKey === 'nav.group.brand'
        ? brandContext?.resolution.kind === 'brand'
          ? brandContext.resolution.brand.name
          : brandContext?.resolution.kind === 'all'
            ? t('brand.allBrands')
            : t('nav.group.brand')
        : group.titleKey
          ? t(group.titleKey)
          : undefined;
    sections.push({ title, items });
  }
  return sections;
}

/**
 * The two lines the brand card shows, for each of the four resolutions.
 *
 * THE CARD NEVER LIES ABOUT WHICH BRAND YOU ARE ON. "No brand selected" is a
 * state the reader can see and act on; the alternative — showing a brand name
 * nobody chose — is the silent guess this whole phase exists to remove.
 */
function brandTrigger(
  context: BrandContext,
  t: (key: MessageKey) => string,
): { name: string; caption: string } {
  switch (context.resolution.kind) {
    case 'brand':
      return { name: context.resolution.brand.name, caption: t('brand.selectedCaption') };
    case 'all':
      return { name: t('brand.allBrands'), caption: t('brand.allBrandsCaption') };
    case 'unselected':
      return { name: t('brand.noneSelected'), caption: t('brand.noneSelectedCaption') };
    case 'empty':
      return { name: t('brand.noBrands'), caption: t('brand.noBrandsCaption') };
  }
}

export async function WorkspaceShell({
  locale,
  heading,
  description,
  actions,
  meta,
  hero,
  activePath,
  workspaceName,
  roleName,
  customerName,
  permissionKeys,
  availableWorkspaces = [],
  brandContext,
  focus = false,
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
  /** The signed-in person, for the rail's profile card. Their email if unnamed. */
  customerName?: string | undefined;
  permissionKeys: readonly string[];
  availableWorkspaces?: ReadonlyArray<{
    id: string;
    name: string;
    roleName: string;
    current: boolean;
  }>;
  /**
   * The resolved global brand context (D-190).
   *
   * OPTIONAL, and that is deliberate rather than lax: the sign-in, workspace
   * chooser and no-workspace screens render this shell without a workspace to
   * resolve brands in. A page that HAS a workspace passes it, and the selector
   * appears; a page that does not simply has no second card.
   */
  brandContext?: BrandContext | undefined;
  /**
   * FOCUSED PRESENTATION (Phase 6 final acceptance, D-303) — the first-run
   * Setup Wizard. The daily navigation and the top-bar actions step aside so
   * the journey is the only thing on the screen; the brand, the language
   * switch and the account menu (sign-out) remain. Authorization is the page's
   * own, exactly as without it.
   */
  focus?: boolean | undefined;
  children: ReactNode;
}) {
  const t = translator(locale);
  const other = locale === 'ar' ? 'en' : 'ar';

  /*
   * THE SAME PAGE, IN THE OTHER LANGUAGE (PHASE 2).
   *
   * This used to be `/${other}${activePath ?? '/overview'}`. `activePath` is
   * the NAV ITEM's path, which is a different thing from the route: on
   * `/en/content/compose?item=…` it is `/content`, so switching to Arabic
   * dropped the composer and the draft being edited, and on the routes that
   * pass no `activePath` at all it fell back to `/overview` — changing language
   * moved the reader to a page they had not asked for. The query string went
   * too, and with it every filter, the asset cursor and the selected row.
   *
   * The middleware puts the real path and query on the request, so the switch
   * is now the same route with one segment changed. `activePath` remains the
   * fallback for anything that reaches this component without the header.
   */
  const requestPath = (await headers()).get('x-brandspace-path');
  const localeHref = (target: string): string =>
    switchLocalePath(requestPath, target, `/${target}${activePath ?? '/overview'}`);
  const identity = customerName ?? workspaceName;

  /*
   * THE TOP BAR (P6-16): Review · Notes · Notifications · Copilot · Create,
   * each to the screen that owns it, each on the permission that screen
   * demands, and each dot drawn only from a real count (`topbar-counts.ts`).
   */
  const topbar = topbarModel({
    locale,
    permissionKeys,
    requestPath,
    counts: await topbarCounts(),
  });

  const sections = focus ? [] : navSections(permissionKeys, locale, activePath, t, brandContext);

  /*
   * THE GLOBAL COPILOT (D-277 §37): what the drawer opens with — the rail's
   * brand, this screen as its surface, and the object this address names,
   * read under the reader's scope. Only when the top bar offers the Copilot.
   */
  const copilotLink = topbar.links.find((link) => link.key === 'copilot' && !link.current);
  const drawerBrand =
    brandContext?.resolution.kind === 'brand'
      ? { id: brandContext.resolution.brand.id, name: brandContext.resolution.brand.name }
      : null;
  const drawerSubject = copilotLink
    ? await copilotDrawerSubject(requestPath, drawerBrand?.id ?? null, locale)
    : null;

  /*
   * THE BRAND PROFILE ROW NEEDS A BRAND *AND* THE PERMISSION TO READ ONE.
   *
   * `/settings/brand` calls `requireWorkspace(locale, 'brand.read')` and answers
   * 404 without it, so offering the row to a member who does not hold it is a
   * link to a dead end — and a dead end that looks like a permissions bug to
   * the person who clicks it.
   *
   * DEAD-LINK PREVENTION ONLY. The route authorizes independently and nothing
   * here is load-bearing for security: typing the URL still fails, identically
   * to a route that does not exist (CLAUDE.md §2.1).
   */
  const mayReadBrandProfile = permissionKeys.includes('brand.read');

  /*
   * HOW MANY BUSINESSES THIS PERSON BELONGS TO (D-302). "Switch business" is
   * offered in the account menu only when there is another one to switch to;
   * the count comes from the same membership listing the picker reads.
   */
  const businessCount =
    availableWorkspaces.length > 0
      ? availableWorkspaces.length
      : (
          await getCustomerAuth()
            .listWorkspaces((await getSessionToken()) ?? '')
            .catch(() => [])
        ).length;

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
        /*
         * THE BRAND, AND ONLY THE BRAND (Phase 6 final acceptance, D-302).
         *
         * The workspace is the tenant boundary — membership, billing, RLS,
         * audit — and it stays exactly that, underneath. It is no longer a card
         * in the customer's rail: a standard business has one workspace and one
         * brand, and "what is the difference between my workspace and my
         * brand?" is a question the product should never make them ask. A
         * member of more than one business switches from the account menu.
         *
         * ONE REACHABLE BRAND IS A CARD, NOT A MENU. The selector returns,
         * unchanged, when a second brand is reachable — which the plan's brand
         * quota (`limit.brands`, the existing entitlement) is what permits. That
         * is the future multi-brand mode, switched on by configuration rather
         * than by code.
         */
        brandContext ? (
          brandContext.brands.length === 1 && brandContext.brands[0] ? (
            <BrandCard
              label={t('brand.cardLabel')}
              current={{
                name: brandContext.brands[0].name,
                caption: t('brand.selectedCaption'),
              }}
              href={
                mayReadBrandProfile
                  ? `/${locale}/settings/brand?brand=${brandContext.brands[0].id}`
                  : undefined
              }
            />
          ) : (
            <BrandSwitcher
              label={t('brand.switcherLabel')}
              current={brandTrigger(brandContext, t)}
              options={brandContext.brands.map((brand) => ({
                id: brand.id,
                name: brand.name,
                current: brandContext.selectedValue === brand.id,
              }))}
              action={selectBrandAction}
              hiddenFields={{ locale, next: localeHref(locale) }}
              {...(brandContext.aggregateAllowed
                ? {
                    allOption: {
                      label: t('brand.allBrands'),
                      current: brandContext.resolution.kind === 'all',
                    },
                  }
                : {})}
              emptyLabel={t('brand.emptyMenu')}
              {...(brandContext.resolution.kind === 'brand' && mayReadBrandProfile
                ? {
                    manageHref: `/${locale}/settings/brand?brand=${brandContext.resolution.brand.id}`,
                    manageLabel: t('brand.profile'),
                  }
                : {})}
            />
          )
        ) : null
      }
      headerEnd={
        /*
         * THE CUSTOMER TOP BAR (P6-16). The demo's composition — square
         * `.icon-button`s, the 38px language square and the purple
         * `.primary-button.compact` — with every control leading to a real
         * screen. The search control is gone rather than faked: no search
         * domain exists behind it (D-276).
         */
        <>
          {(focus ? [] : topbar.links).map((link) => {
            const count = link.count ?? 0;
            const control = (
              <TopbarLink
                key={link.key}
                href={link.href}
                label={t(link.labelKey)}
                glyph={link.key}
                current={link.current}
                testId={`topbar-${link.key}`}
                // D-304 — the Copilot is named on screen, not only by its spark.
                showLabel={link.key === 'copilot'}
                indicator={
                  link.countKey && count > 0
                    ? { count, label: t(link.countKey).replace('{count}', String(count)) }
                    : null
                }
              />
            );
            // D-297 — the bell opens its feed over the screen (still a link without script).
            if (link.key === 'notifications' && !link.current) {
              return (
                <NotificationsBell
                  key={link.key}
                  locale={locale}
                  href={link.href}
                  load={loadNotificationFeed}
                  strings={{
                    title: t('notifications.title'),
                    close: t('common.close'),
                    all: t('notifications.feed.all'),
                    mentions: t('notifications.feed.mentions'),
                    approvals: t('notifications.feed.approvals'),
                    seeAll: t('notifications.feed.seeAll'),
                    open: t('notifications.view'),
                    unread: t('notifications.unread'),
                    loading: t('notifications.feed.loading'),
                    emptyTitle: t('notifications.emptyTitle'),
                    emptyBody: t('notifications.emptyBody'),
                    error: t('notifications.feed.error'),
                  }}
                >
                  {control}
                </NotificationsBell>
              );
            }
            return link === copilotLink ? (
              <GlobalCopilot
                key={link.key}
                locale={locale}
                href={link.href}
                brand={drawerBrand}
                surface={copilotSurfaceForPath(requestPath)}
                subject={drawerSubject}
                labels={copilotLabels(locale, identity)}
                strings={{
                  openFull: t('copilot.openFull'),
                  chooseBrandTitle: t('brand.chooseTitle'),
                  chooseBrandBody: t('copilot.noBrandBody'),
                }}
              >
                {control}
              </GlobalCopilot>
            ) : (
              control
            );
          })}
          <LanguageSwitcher
            href={localeHref(other)}
            targetLocale={other}
            targetLabel={other === 'ar' ? 'العربية' : 'English'}
            ariaLabel={t('nav.language')}
          />
          {focus ? null : (
            <TopbarCreateMenu
              label={t('topbar.create')}
              items={topbar.create.map((item) => ({
                key: item.key,
                href: item.href,
                label: t(item.labelKey),
              }))}
            />
          )}
        </>
      }
      /*
       * EVERY route gets the top-bar title, the Overview included: the
       * reference's home view has BOTH an `h1` in the bar ("Good morning, …")
       * and an `h2` hero statement below it. The hero is a second block, never
       * a replacement for the first.
       */
      pageEyebrow={t('page.eyebrow')}
      pageTitle={heading}
      pageDescription={description}
      pageMeta={meta}
      profile={
        /*
         * THE DEMO'S PROFILE CARD (§8): avatar, name, role and a real `•••`
         * menu holding sign-out. It replaces the standalone sign-out row, which
         * was visually unrelated to the demo.
         */
        <ProfileCard
          label={t('nav.account')}
          name={identity}
          role={roleName}
          initials={initialsFrom(identity)}
        >
          {businessCount > 1 ? (
            <Link
              href={`/${locale}/workspaces`}
              role="menuitem"
              data-testid="switch-workspace"
              style={menuItemStyle()}
            >
              {t('ws.switchBusiness')}
            </Link>
          ) : null}
          <form action={signOutAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" role="menuitem" data-testid="sign-out" style={menuItemStyle()}>
              {t('nav.signOut')}
            </button>
          </form>
        </ProfileCard>
      }
    >
      {/*
        THE TITLE IS IN THE TOP BAR NOW (fidelity pass §4/§5).

        `PageHeader` used to render it here, one block below the bar, which is
        exactly the "visually lower or detached" composition the reference does
        not have. The shell passes the title up instead, so every route gets the
        reference's single `eyebrow → h1 → actions` block and the first content
        surface starts immediately underneath it.

        Page-level actions still render here when a page has them, because the
        top-bar actions are global (review, notes, notifications, Copilot, create)
        rather than page-specific.
      */}
      {hero ?? null}
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
  /*
   * Phase 7 widens this to the design system's full `Tone`. Analytics needs a
   * `warning` for the two honesty notices — figures that came from a mock
   * source, and figures older than the configured freshness window — and
   * neither is a success or an error: the screen is working exactly as
   * intended, and the reader still has to be told.
   */
  tone: Tone;
  children: ReactNode;
}) {
  return <Banner tone={tone}>{children}</Banner>;
}

/*
 * RE-EXPORTED, NOT DEFINED HERE. They live in `customer-styles.ts` so a client
 * component can reach them without importing this server shell — see that
 * file's note. Server callers keep their existing import path.
 */
export {
  customerButtonStyle,
  customerInputStyle,
  customerSecondaryButtonStyle,
  customerTableStyle,
  customerTdStyle,
  customerThStyle,
} from './customer-styles';
