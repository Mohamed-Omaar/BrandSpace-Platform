import { headers } from 'next/headers';
import { systemClock } from '@brandspace/shared';
import { Suspense, type ReactNode } from 'react';
import {
  CustomerShell,
  PrototypeBrandCard,
  PrototypeBrandSwitcher,
  PrototypeBusinessSwitcher,
  PrototypeCopilotFab,
  PrototypeCreateMenu,
  PrototypeIcon,
  PrototypeLanguageSwitch,
  PrototypeMenuLink,
  PrototypeTopbarLink,
  PrototypeUserCard,
  Banner,
  StateMessage,
  type CustomerNavSection,
  type PrototypeCreateItem,
  type PrototypeGlyph,
  type Tone,
  initialsFrom,
  ToastHost,
} from '@brandspace/ui';
import { switchLocalePath } from '../i18n/locale-path';
import { customerRoleName, translator, type MessageKey } from '../i18n/messages';
import type { BrandContext } from '../server/brand-context';
import { topbarModel, type TopbarCounts } from '../server/topbar';
import { copilotSurfaceForPath } from '../server/copilot-surface';
import { RATE_METRIC_KEYS, copilotLabels } from '../server/copilot-labels';
import { copilotDrawerSubject } from '../server/copilot-context';
import { GlobalCopilot } from './global-copilot';
import { NotificationsBell } from './notifications-bell';
import { loadNotificationFeed } from '../app/[locale]/notifications/feed';
import { SETTINGS_PATHS, settingsLandingPath } from '../server/settings-nav';
import { topbarCounts } from '../server/topbar-counts';
import { incomingMentions } from '../server/incoming-mentions';
import { getCustomer, getCustomerAuth, getSessionToken } from '../server/customer-context';
import { greetingName } from '../server/home';
import { businessSwitcherModel } from '../server/business-switcher';
import { selectBrandAction } from '../app/[locale]/brand-context-actions';

import { signOutAction, switchWorkspaceAction } from '../app/[locale]/(auth)/actions';
import { requestMessageLocale } from '../server/message-locale';
import { MessageLocaleProvider } from '../i18n/message-locale-context';

/**
 * The authenticated customer shell — PORTED FROM `prototype-2026-09-27` (D-468).
 *
 * The frame, the rail, the top bar and the floating Copilot are the prototype's
 * own (`Main.dc.html` lines 79–191 and 1483, `CustomerShell` and
 * `prototype-rail.tsx` in `@brandspace/ui`, `prototype.css`). This file decides
 * only WHAT they carry: which rail entries this member may open, the real
 * counts beside them, the brand or business card, the account menu and the
 * creation flows.
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
  glyph: PrototypeGlyph;
  /** Which of the shell's counts the prototype draws beside it. */
  count?: 'review' | 'failed' | 'notes' | 'team';
}

/*
 * THE PROTOTYPE'S RAIL, IN ITS ORDER (`Main.dc.html` lines 102–129): Home; the
 * brand's own group with Brand Brain; Plan — Strategy, Campaigns; Create —
 * Posts, Media; Publish — Approvals, Calendar, Publishing log; Improve —
 * Performance; Automate — Automations, Notes; Workspace — Team, Settings.
 *
 * TWO ENTRIES THE PROTOTYPE'S RAIL DOES NOT HAVE, KEPT FOR NOW. The prototype
 * folds the AI Creative Studio into Media ("Media = the media library + a
 * Generate tab in place of the AI Creative Studio page", line 2172) and
 * Marketing Intelligence into Performance's Insights. Neither home exists in
 * the product until Media (batch 3) and Performance (batch 4) are ported, and
 * without a rail entry a member who may open either screen could lose the only
 * general way to it (the Create menu also asks `copilot.use`; Intelligence
 * asks `strategy.read`, not `analytics.read`). So both stay, after the
 * prototype's own entries in their groups, until their prototype homes land.
 */
const NAV: readonly NavEntry[] = [
  { href: '/overview', key: 'nav.overview', permission: null, glyph: 'home' },
  {
    href: '/brand-brain',
    key: 'nav.brandBrain',
    permission: 'brand_brain.read',
    glyph: 'brain',
  },
  {
    href: '/strategy',
    key: 'nav.strategy',
    permission: 'strategy.read',
    glyph: 'strategy',
  },
  {
    href: '/campaigns',
    key: 'nav.campaigns',
    permission: 'campaigns.read',
    glyph: 'campaigns',
  },
  {
    href: '/content',
    key: 'nav.rail.posts',
    permission: 'content.read',
    glyph: 'posts',
  },
  {
    href: '/assets',
    key: 'nav.rail.media',
    permission: 'assets.read',
    glyph: 'media',
  },
  {
    href: '/approvals',
    key: 'nav.approvals',
    permission: 'content.read',
    glyph: 'approvals',
    count: 'review',
  },
  {
    href: '/calendar',
    key: 'nav.calendar',
    permission: 'content.read',
    glyph: 'calendar',
  },
  {
    href: '/publishing',
    key: 'nav.rail.publishingLog',
    permission: 'publishing.read',
    glyph: 'publishing',
    count: 'failed',
  },
  {
    href: '/analytics',
    key: 'nav.rail.performance',
    permission: 'analytics.read',
    glyph: 'performance',
  },
  {
    href: '/automations',
    key: 'nav.automations',
    permission: 'automation.read',
    glyph: 'automations',
  },
  {
    href: '/notes',
    key: 'nav.rail.notes',
    permission: 'content.read',
    glyph: 'notes',
    count: 'notes',
  },
  {
    href: '/members',
    key: 'nav.members',
    permission: 'member.read',
    glyph: 'team',
    count: 'team',
  },
  /*
   * SETTINGS is for EVERY member: it holds Security, Roles & permissions and
   * Activity, which ask no permission. Its href is resolved per member to the
   * first section they may open (`settingsLandingPath`), so it never 404s.
   */
  { href: '/settings', key: 'nav.settings', permission: null, glyph: 'settings' },
];

/**
 * The rail item a route belongs to, from the real request path
 * (`x-brandspace-path`): the item itself, the Settings section (or Settings
 * for a page under one), or the deepest rail item the route sits under.
 */
function railPathFromRequest(requestPath: string | null): string | undefined {
  if (!requestPath) return undefined;
  const path = (requestPath.split('?')[0] ?? '').replace(/^\/(?:en|ar)(?=\/|$)/, '') || '/';
  const under = (base: string) => path === base || path.startsWith(`${base}/`);
  const deepest = (candidates: readonly string[]) =>
    [...candidates].filter(under).sort((a, b) => b.length - a.length)[0];
  return deepest(SETTINGS_PATHS) ?? deepest(NAV.map((item) => item.href));
}

const NAV_GROUPS: readonly { titleKey: MessageKey | null; hrefs: readonly string[] }[] = [
  { titleKey: null, hrefs: ['/overview'] },
  { titleKey: 'nav.group.brand', hrefs: ['/brand-brain'] },
  { titleKey: 'nav.group.plan', hrefs: ['/strategy', '/campaigns'] },
  { titleKey: 'nav.group.create', hrefs: ['/content', '/assets'] },
  { titleKey: 'nav.group.publish', hrefs: ['/approvals', '/calendar', '/publishing'] },
  { titleKey: 'nav.group.improve', hrefs: ['/analytics'] },
  { titleKey: 'nav.group.automate', hrefs: ['/automations', '/notes'] },
  { titleKey: 'nav.group.workspace', hrefs: ['/members', '/settings'] },
];

function navSections(
  permissionKeys: readonly string[],
  locale: string,
  activePath: string | undefined,
  t: (key: MessageKey) => string,
  brandContext: BrandContext | undefined,
  counts: TopbarCounts,
): readonly CustomerNavSection[] {
  const byHref = new Map(NAV.map((item) => [item.href, item]));
  const placed = NAV_GROUPS.flatMap((group) => group.hrefs);
  if (placed.length !== NAV.length || new Set(placed).size !== NAV.length) {
    // A programming error, not a runtime condition: it can only be reached by
    // editing NAV or NAV_GROUPS and not the other.
    throw new Error('Every NAV entry must appear in exactly one NAV_GROUPS entry.');
  }
  const countFor = (entry: NavEntry) => {
    const value =
      entry.count === 'review'
        ? counts.review
        : entry.count === 'failed'
          ? counts.failed
          : entry.count === 'notes'
            ? counts.notes
            : entry.count === 'team'
              ? counts.team
              : null;
    if (typeof value !== 'number' || value <= 0) return undefined;
    const fill = (key: MessageKey) => t(key).replace('{count}', String(value));
    switch (entry.count) {
      case 'review':
        return { text: String(value), tone: 'ink' as const, label: fill('topbar.reviewCount') };
      case 'failed':
        return { text: String(value), tone: 'bad' as const, label: fill('nav.count.failed') };
      case 'notes':
        return { text: String(value), tone: 'brand' as const, label: fill('topbar.notesCount') };
      case 'team':
        return { text: String(value), tone: 'quiet' as const, label: fill('nav.count.team') };
      default:
        return undefined;
    }
  };

  // The rail entries this member sees, other than Settings itself.
  const onRail = new Set(
    NAV_GROUPS.flatMap((group) => group.hrefs)
      .filter((href) => href !== '/settings')
      .filter((href) => {
        const entry = byHref.get(href);
        return (
          entry !== undefined &&
          (entry.permission === null || permissionKeys.includes(entry.permission))
        );
      }),
  );
  /*
   * Round 4, 2.3 — Roles & permissions is the prototype's "Team & roles": the
   * rail marks Team there, as the prototype's does. A member without Team on
   * the rail keeps Settings, the section's own parent.
   */
  const current = activePath === '/permissions' && onRail.has('/members') ? '/members' : activePath;
  const sections: CustomerNavSection[] = [];
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
        icon: <PrototypeIcon glyph={item.glyph} />,
        // Settings stands for its sections — unless the section has its own
        // rail entry (Team): one current item, never two (round 3, C3).
        active:
          current === item.href ||
          (item.href === '/settings' &&
            current !== undefined &&
            SETTINGS_PATHS.includes(current) &&
            !onRail.has(current)),
        // The existing convention, preserved: renaming these would drop the
        // end-to-end assertions that use them.
        testId: `nav-${item.href.slice(1)}`,
        count: countFor(item),
      }));
    if (items.length === 0) continue;
    /*
     * THE BRAND GROUP IS TITLED WITH THE BRAND (`<div class="grp"><bdi>
     * {{t.brandName}}</bdi></div>`). "All brands" when that is the selection;
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

/** The creation flows, as the prototype's Create menu names and draws them. */
const CREATE_ITEM: Readonly<
  Record<string, { label: MessageKey; sub: MessageKey; glyph: PrototypeGlyph }>
> = {
  content: { label: 'topbar.menu.post', sub: 'topbar.menu.postSub', glyph: 'posts' },
  campaign: { label: 'topbar.menu.campaign', sub: 'topbar.menu.campaignSub', glyph: 'campaigns' },
  creative: { label: 'topbar.menu.image', sub: 'topbar.menu.imageSub', glyph: 'spark' },
  asset: { label: 'topbar.menu.upload', sub: 'topbar.menu.uploadSub', glyph: 'upload' },
};

/** `+ New workspace` and the menu's note, at the prototype's 12.5px in its deep purple. */
const MENU_LINK = {
  display: 'flex',
  justifyContent: 'space-between',
  borderRadius: 'var(--bsp-px-10)',
  padding: 'var(--bsp-px-7) var(--bsp-px-10)',
  fontSize: 'var(--bsp-t-12_5)',
  fontWeight: 600,
  textDecoration: 'none',
} as const;
const MENU_NOTE = {
  margin: 0,
  fontSize: 'var(--bsp-t-11)',
  padding: 'var(--bsp-px-2) var(--bsp-px-10) var(--bsp-px-6)',
  lineHeight: 1.45,
} as const;

export async function WorkspaceShell({
  locale,
  eyebrow,
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
  flash,
  children,
}: {
  locale: string;
  /**
   * The eyebrow over the title — the screen's group, as the prototype's
   * `heads` table gives it ("Publish" over the calendar). Home's
   * "Your business" when absent.
   */
  eyebrow?: string | undefined;
  /**
   * The page title. THE SHELL OWNS THE `h1`, so every page has exactly one and
   * no page can forget it — which is what the accessibility suite asserts.
   */
  heading: string;
  description?: string | undefined;
  /** Page-level actions, rendered above the page's content. */
  actions?: ReactNode;
  /** Badges or status pills that belong next to the top bar's controls. */
  meta?: ReactNode;
  /** A page's own lead surface (Home's hero), the first block under the bar. */
  hero?: ReactNode;
  /**
   * The current path segment, e.g. `/members`. Marks the active nav item and
   * keeps the language switcher on the page the reader is actually on.
   */
  activePath?: string | undefined;
  workspaceName: string;
  roleName: string;
  /** The signed-in person, for the rail's user card. Their email if unnamed. */
  customerName?: string | undefined;
  permissionKeys: readonly string[];
  availableWorkspaces?: ReadonlyArray<{
    id: string;
    name: string;
    roleName: string;
    current: boolean;
  }>;
  /**
   * The resolved global brand context (D-190). OPTIONAL: the sign-in, workspace
   * chooser and no-workspace screens render this shell without a workspace.
   */
  brandContext?: BrandContext | undefined;
  /**
   * FOCUSED PRESENTATION (D-303) — the first-run Setup Wizard. The daily
   * navigation and the top-bar actions step aside; the brand, the language and
   * the account menu (sign-out) remain.
   */
  focus?: boolean | undefined;
  /** C8 — this request's success, as a toast. */
  flash?: { readonly tone: 'success'; readonly message: string } | undefined;
  children: ReactNode;
}) {
  // The words this member reads (one Arabic for every country, round 4 Step 6).
  const words = requestMessageLocale(locale);
  const t = translator(words);
  const other = locale === 'ar' ? 'en' : 'ar';
  /*
   * Each language by its own name and its code, the same in either interface
   * (`curLang`/`nextLang` and the language square in the prototype; the auth
   * card names them the same way). Locale data, not copy to translate.
   */
  const ownName = (code: string) => (code === 'ar' ? 'العربية' : 'English');

  /*
   * THE SAME PAGE, IN THE OTHER LANGUAGE: the middleware puts the real path
   * and query on the request, so the switch is the same route with one segment
   * changed. `activePath` is the fallback.
   */
  const requestPath = (await headers()).get('x-brandspace-path');
  /*
   * ROUND 4 (2.3) — EVERY PAGE MARKS ITS RAIL ITEM. A page that names no
   * `activePath` (Notes, every Settings section, Billing, an invoice) is
   * placed by its own route: a Settings section or sub-page marks Settings,
   * any other sub-page marks its parent.
   */
  const railPath = activePath ?? railPathFromRequest(requestPath);
  const localeHref = (target: string): string =>
    switchLocalePath(requestPath, target, `/${target}${railPath ?? '/overview'}`);
  /*
   * ROUND 4 (4.4) — THE PERSON'S NAME, EVERYWHERE. The rail's card names the
   * signed-in person from their own account, whatever a page passed: the name,
   * and the email only when there is no name. The initials are Latin in both
   * languages — from the name when it is written in Latin letters, else from
   * the email — so the avatar reads the same in `ar` and `en`.
   */
  const me = await getCustomer().catch(() => null);
  const personName = me?.name?.trim() ?? '';
  const personEmail = me?.email ?? customerName;
  const identity = personName || personEmail || workspaceName;
  const latinInitialsFrom = personName && /[A-Za-z]/.test(personName) ? personName : personEmail;

  const counts = await topbarCounts();
  const topbar = topbarModel({ locale, permissionKeys, requestPath, counts });
  const sections = focus
    ? []
    : navSections(permissionKeys, locale, railPath, t, brandContext, counts);

  /*
   * THE GLOBAL COPILOT (D-277 §37): what the drawer opens with — the rail's
   * brand, this screen as its surface, and the object this address names.
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
   * The panel's head line (`x.ctx`, round 3): "Working on: Home", then the
   * brand every step acts on (D-190) and the object this address names.
   */
  const drawerSurface = copilotSurfaceForPath(requestPath);
  const drawerContext = [
    t('copilot.workingOn').replace(
      '{screen}',
      drawerSurface === 'general'
        ? (drawerBrand?.name ?? t('copilot.title'))
        : t(`copilot.surface.${drawerSurface}` as MessageKey),
    ),
    drawerSurface !== 'general' ? (drawerBrand?.name ?? null) : null,
    drawerSubject ? t('copilot.contextSubject').replace('{subject}', drawerSubject.title) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  // The greeting's name is the person's own first name, never their email.
  const firstName = copilotLink ? greetingName(me?.name) : null;

  /*
   * THE BRAND PROFILE ROW NEEDS A BRAND *AND* THE PERMISSION TO READ ONE:
   * `/settings/brand` answers 404 without `brand.read`. Dead-link prevention
   * only; the route authorizes independently.
   */
  const mayReadBrandProfile = permissionKeys.includes('brand.read');

  /* How many businesses this person belongs to (D-302). */
  const businessCount =
    availableWorkspaces.length > 0
      ? availableWorkspaces.length
      : (
          await getCustomerAuth()
            .listWorkspaces((await getSessionToken()) ?? '')
            .catch(() => [])
        ).length;

  /*
   * THE BUSINESS SWITCHER (Q1 / Q2, D-326). With one brand in view the rail's
   * card opens the businesses, with the owner's allowance at its head and foot
   * (`.bmenu`: "Workspaces · 1/2", "+ New workspace  1/2", the note).
   */
  const activeWorkspaceId =
    brandContext && brandContext.brands.length < 2 ? (me?.activeWorkspaceId ?? null) : null;
  const switcher = activeWorkspaceId
    ? await businessSwitcherModel(locale, activeWorkspaceId)
    : null;
  const usage =
    switcher && switcher.foot.kind !== 'none' && switcher.foot.kind !== 'unavailable'
      ? switcher.foot.allowed === null
        ? null
        : `${switcher.foot.used}/${switcher.foot.allowed}`
      : null;

  const brandCard = brandContext ? (
    brandContext.brands.length >= 2 ? (
      <PrototypeBrandSwitcher
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
    ) : switcher ? (
      <PrototypeBusinessSwitcher
        label={t('ws.switcherLabel')}
        heading={
          <span data-testid={usage ? 'workspace-usage' : undefined}>
            {t('ws.menuHeading')}
            {usage ? (
              <>
                {' · '}
                <span className="bsp-ltr">{usage}</span>
              </>
            ) : null}
          </span>
        }
        current={{
          name: brandContext.brands[0]?.name ?? workspaceName,
          // The prototype's card reads "Active brand"; Role · Plan stays on each
          // business in the menu (review of #67, round 2).
          caption: brandContext.brands[0] ? t('brand.selectedCaption') : switcher.currentCaption,
        }}
        options={switcher.options}
        action={switchWorkspaceAction}
        hiddenFields={{ locale }}
        footer={
          <>
            {switcher.foot.kind === 'create' ? (
              <a
                href={`/${locale}/onboarding/workspace`}
                role="menuitem"
                data-testid="workspace-new"
                style={{ ...MENU_LINK, color: 'var(--bs-brand-purple-pressed)' }}
              >
                <span>{t('ws.new')}</span>
                {usage ? (
                  <span
                    className="bsp-ltr"
                    style={{
                      fontSize: 'var(--bsp-t-11)',
                      color: 'var(--bsp-faint)',
                      fontWeight: 500,
                    }}
                  >
                    {usage}
                  </span>
                ) : null}
              </a>
            ) : null}
            {switcher.foot.kind === 'unavailable' ? (
              // Owner decision (PR #47): an allowance of 0 never reads "N of 0".
              <>
                <p
                  data-testid="workspace-unavailable"
                  style={{ ...MENU_NOTE, color: 'var(--bsp-faint)' }}
                >
                  {t('ws.unavailable')}
                </p>
                {permissionKeys.includes('billing.read') ? (
                  <a
                    href={`/${locale}/plan`}
                    role="menuitem"
                    data-testid="workspace-unavailable-upgrade"
                    style={{ ...MENU_LINK, color: 'var(--bs-brand-purple-pressed)' }}
                  >
                    {t('ws.unavailableUpgrade')}
                  </a>
                ) : (
                  <p
                    data-testid="workspace-unavailable-upgrade"
                    style={{ ...MENU_NOTE, color: 'var(--bsp-faint)' }}
                  >
                    {t('ws.unavailableUpgrade')}
                  </p>
                )}
              </>
            ) : null}
            {switcher.foot.kind === 'limit' ? (
              <>
                <p
                  data-testid="workspace-limit"
                  style={{ ...MENU_NOTE, color: 'var(--bsp-faint)' }}
                >
                  {t('ws.limitReached')}
                </p>
                {permissionKeys.includes('billing.read') ? (
                  <a
                    href={`/${locale}/plan`}
                    role="menuitem"
                    data-testid="workspace-upgrade"
                    style={{ ...MENU_LINK, color: 'var(--bs-brand-purple-pressed)' }}
                  >
                    {t('ws.upgrade')}
                  </a>
                ) : null}
              </>
            ) : null}
            {brandContext.brands[0] && mayReadBrandProfile ? (
              <a
                href={`/${locale}/settings/brand?brand=${brandContext.brands[0].id}`}
                role="menuitem"
                data-testid="manage-brand"
                style={{ ...MENU_LINK, color: 'var(--bs-brand-purple-pressed)' }}
              >
                {t('brand.profile')}
              </a>
            ) : null}
            {switcher.foot.kind === 'none' ? null : (
              <p style={{ ...MENU_NOTE, color: 'var(--bsp-faint)' }}>{t('ws.menuNote')}</p>
            )}
          </>
        }
      />
    ) : brandContext.brands[0] ? (
      <PrototypeBrandCard
        label={t('brand.cardLabel')}
        current={{ name: brandContext.brands[0].name, caption: t('brand.selectedCaption') }}
        href={
          mayReadBrandProfile
            ? `/${locale}/settings/brand?brand=${brandContext.brands[0].id}`
            : undefined
        }
      />
    ) : null
  ) : null;

  /* The top bar: notes, notifications, the language square, Create. */
  const notesLink = topbar.links.find((link) => link.key === 'notes');
  const bellLink = topbar.links.find((link) => link.key === 'notifications');
  const bell = bellLink ? (
    <PrototypeTopbarLink
      href={bellLink.href}
      label={t(bellLink.labelKey)}
      glyph="notifications"
      count={bellLink.count}
      countLabel={
        bellLink.countKey && bellLink.count
          ? t(bellLink.countKey).replace('{count}', String(bellLink.count))
          : undefined
      }
      current={bellLink.current}
      testId="topbar-notifications"
    />
  ) : null;
  const headerActions = (
    <>
      {focus || !notesLink ? null : (
        <PrototypeTopbarLink
          href={notesLink.href}
          label={t(notesLink.labelKey)}
          glyph="notes"
          count={notesLink.count}
          countLabel={
            notesLink.countKey && notesLink.count
              ? t(notesLink.countKey).replace('{count}', String(notesLink.count))
              : undefined
          }
          current={notesLink.current}
          testId="topbar-notes"
          // The prototype draws the unread notes on the rail, not on this square.
          showCount={false}
        />
      )}
      {focus || !bellLink ? null : bellLink.current ? (
        bell
      ) : (
        // D-297 — the bell opens its feed over the screen (still a link without script).
        <NotificationsBell
          locale={locale}
          href={bellLink.href}
          load={loadNotificationFeed}
          strings={{
            title: t('notifications.title'),
            close: t('notifications.dismiss'),
            markAll: t('notifications.markAllRead'),
            seeAll: t('notifications.feed.seeAll'),
            open: t('notifications.view'),
            unread: t('notifications.unread'),
            loading: t('notifications.feed.loading'),
            emptyTitle: t('notifications.emptyTitle'),
            emptyBody: t('notifications.emptyBody'),
            error: t('notifications.feed.error'),
          }}
        >
          {bell}
        </NotificationsBell>
      )}
      <PrototypeLanguageSwitch
        href={localeHref(other)}
        targetLocale={other}
        targetLetters={other.toUpperCase()}
        label={t('topbar.switchLanguage')}
      />
      {focus ? null : (
        <PrototypeCreateMenu
          label={t('topbar.create')}
          items={topbar.create
            .map((item): PrototypeCreateItem | null => {
              const copy = CREATE_ITEM[item.key];
              return copy
                ? {
                    key: item.key,
                    href: item.href,
                    label: t(copy.label),
                    sub: t(copy.sub),
                    glyph: copy.glyph,
                  }
                : null;
            })
            .filter((item): item is PrototypeCreateItem => item !== null)}
        />
      )}
    </>
  );

  /* The floating Copilot (`.fab`), for a member who may use it. */
  const copilot = topbar.links.find((link) => link.key === 'copilot');
  const fab =
    focus || !copilot ? null : copilotLink ? (
      <GlobalCopilot
        locale={locale}
        now={systemClock.now().toISOString()}
        href={copilotLink.href}
        brand={drawerBrand}
        surface={drawerSurface}
        subject={drawerSubject}
        labels={copilotLabels(words, identity)}
        rateMetricKeys={RATE_METRIC_KEYS}
        strings={{
          chooseBrandTitle: t('brand.chooseTitle'),
          chooseBrandBody: t('copilot.noBrandBody'),
          context: drawerContext,
          credits:
            typeof counts.credits === 'number' && permissionKeys.includes('billing.read')
              ? counts.credits.toLocaleString('en-US')
              : null,
          creditsLabel: t('account.credits'),
          greeting: firstName
            ? t('copilot.hello').replace('{name}', firstName)
            : t('copilot.hello').replace(/\s?\{name\}/, ''),
          placeholder: t('copilot.askPlaceholder'),
          suggestions: [
            { id: 'posts', label: t('copilot.suggest.posts') },
            { id: 'engagement', label: t('copilot.suggest.engagement') },
            { id: 'approvals', label: t('copilot.suggest.approvals') },
          ],
        }}
      >
        <PrototypeCopilotFab
          href={copilotLink.href}
          label={t('topbar.copilot')}
          testId="topbar-copilot"
        />
      </GlobalCopilot>
    ) : (
      <PrototypeCopilotFab
        href={copilot.href}
        label={t('topbar.copilot')}
        current
        testId="topbar-copilot"
      />
    );

  /*
   * THE USER CARD (`.ucard`) AND ITS MENU (`.umenu`): the person's name and
   * email, "AI credits" with the balance for those who may read it, the
   * language, sign out. "Switch business" stays for a member of more than one
   * business while several brands are in view (D-302), because the brand
   * selector then holds brands, not businesses.
   */
  const profile = (
    <PrototypeUserCard
      label={t('nav.account')}
      name={identity}
      email={personName ? personEmail : undefined}
      role={customerRoleName(roleName)}
      initials={initialsFrom(latinInitialsFrom ?? identity)}
    >
      {typeof counts.credits === 'number' && permissionKeys.includes('billing.read') ? (
        <PrototypeMenuLink
          href={`/${locale}/billing`}
          testId="account-credits"
          trailing={
            <span className="bsp-pill bsp-p-ai">
              <PrototypeIcon glyph="spark" size={12} stroke={0} />
              <span className="bsp-ltr">{counts.credits.toLocaleString('en-US')}</span>
            </span>
          }
        >
          {t('account.credits')}
        </PrototypeMenuLink>
      ) : null}
      {businessCount > 1 && brandContext && brandContext.brands.length >= 2 ? (
        <PrototypeMenuLink href={`/${locale}/workspaces`} testId="switch-workspace">
          {t('ws.switchBusiness')}
        </PrototypeMenuLink>
      ) : null}
      <PrototypeMenuLink
        href={localeHref(other)}
        hrefLang={other}
        testId="account-language"
        trailing={
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--bsp-px-6)' }}>
            <b>{ownName(locale)}</b>
            <span style={{ fontSize: 'var(--bsp-t-11)', color: 'var(--bsp-faint)' }}>
              → {ownName(other)}
            </span>
          </span>
        }
      >
        {t('account.language')}
      </PrototypeMenuLink>
      <form action={signOutAction} style={{ margin: 0 }}>
        <input type="hidden" name="locale" value={locale} />
        <button
          type="submit"
          role="menuitem"
          data-testid="sign-out"
          className="bsp-menu-item bsp-sign-out"
        >
          {t('nav.signOut')}
        </button>
      </form>
    </PrototypeUserCard>
  );

  return (
    <MessageLocaleProvider value={words}>
      <CustomerShell
        contentLang={words !== locale ? words : undefined}
        // The logotype, drawn in Latin in both languages as the prototype and the
        // brand mark's own title do — the brand's name, not copy to translate.
        wordmark="Brandspace"
        sections={sections}
        labels={{
          primaryNavigation: t('nav.primary'),
          openNavigation: t('nav.open'),
          closeNavigation: t('nav.close'),
          collapseSidebar: t('nav.collapseMenu'),
          expandSidebar: t('nav.expandMenu'),
        }}
        brandCard={brandCard}
        profile={profile}
        pageEyebrow={eyebrow ?? t('page.eyebrow')}
        pageTitle={heading}
        pageDescription={description}
        pageMeta={meta}
        actions={headerActions}
        fab={fab}
      >
        {hero ?? null}
        {actions ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--bsp-px-8)' }}>{actions}</div>
        ) : null}
        <div className="bs-section-stack">{children}</div>
        {/* `useSearchParams` in the host needs a boundary on a prerendered route. */}
        <Suspense fallback={null}>
          <ToastHost
            flash={flash}
            dismissLabel={t('toast.dismiss')}
            incoming={await incomingMentions(locale)}
            openLabel={t('notifications.incoming.open')}
          />
        </Suspense>
      </CustomerShell>
    </MessageLocaleProvider>
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
  customerInputStyle,
  customerTableStyle,
  customerTdStyle,
  customerThStyle,
} from './customer-styles';
