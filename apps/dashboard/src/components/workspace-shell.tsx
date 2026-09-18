import type { CSSProperties, ReactNode } from 'react';
import {
  AppShell,
  BrandMark,
  ProfileCard,
  TopbarActions,
  menuItemStyle,
  AlertIcon,
  CheckIcon,
  CreditIcon,
  HomeIcon,
  CalendarIcon,
  FlagIcon,
  LayersIcon,
  ListIcon,
  ImageIcon,
  PencilIcon,
  PulseIcon,
  RouteIcon,
  SlidersIcon,
  LanguageSwitcher,
  SendIcon,
  SettingsIcon,
  ShieldIcon,
  SparkIcon,
  TeamIcon,
  WorkspaceSwitcher,
  BrandSwitcher,
  Banner,
  StateMessage,
  buttonStyle,
  inputStyle,
  spacingTokens,
  typographyTokens,
  tdStyle,
  thStyle,
  type ShellNavSection,
  type Tone,
  type WorkspaceOption,
  initialsFrom,
} from '@brandspace/ui';
import { translator, type MessageKey } from '../i18n/messages';
import type { BrandContext } from '../server/brand-context';
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
const NAV: readonly {
  href: string;
  key: MessageKey;
  permission: string | null;
  icon: ReactNode;
}[] = [
  { href: '/overview', key: 'nav.overview', permission: null, icon: <HomeIcon size={20} /> },
  {
    href: '/brand-brain',
    key: 'nav.brandBrain',
    permission: 'brand_brain.read',
    icon: <SparkIcon size={20} />,
  },
  {
    href: '/content',
    key: 'nav.content',
    permission: 'content.read',
    icon: <PencilIcon size={20} />,
  },
  /*
   * PHASE 8 — CAMPAIGNS. The entry appears now because the SCREEN exists now
   * (D-188): the area has been on the fixed inventory since the contract was
   * written, and adding a link before its route was real would have been the
   * dead link §20 forbids. Gated on `campaigns.read`, matching the route.
   *
   * It reads between Content and Calendar because that is where it sits in the
   * work: you plan a campaign, write content into it, then schedule that
   * content.
   */
  {
    href: '/campaigns',
    key: 'nav.campaigns',
    permission: 'campaigns.read',
    // `FlagIcon` reused rather than a new glyph drawn (§4.2 rule 4): a campaign
    // is a marker planted on a period of work, which is what a flag is.
    icon: <FlagIcon size={20} />,
  },
  {
    href: '/calendar',
    key: 'nav.calendar',
    permission: 'content.read',
    icon: <CalendarIcon size={20} />,
  },
  {
    href: '/assets',
    key: 'nav.assets',
    permission: 'assets.read',
    icon: <ImageIcon size={20} />,
  },
  /*
   * PHASE 8 — THE AI CREATIVE STUDIO. The entry appears now because the SCREEN
   * exists now (D-188). Gated on `assets.upload`, matching its route exactly:
   * a generation writes a file into the library, so a member who may only read
   * the library has nothing to do there.
   *
   * It reads after Assets because that is where its output goes.
   */
  {
    href: '/creative',
    key: 'nav.creative',
    permission: 'assets.upload',
    // `SparkIcon` reused rather than a new glyph drawn (§4.2 rule 4): it is the
    // product's mark for "a model did this", and it is what Brand Brain wears.
    icon: <SparkIcon size={20} />,
  },
  /*
   * Phase 5B-3. `/approvals` is gated on `content.read`, matching the route.
   *
   * This was briefly `null` — visible to every member — so that D-121's
   * per-brand Viewer grant was reachable by somebody holding `workspace.read`
   * and nothing else. D-62 supersedes D-121 and makes the Viewer strictly
   * read-only, so the entry goes back to the permission the page requires:
   * offering a link that answers 404 is the dead link §20 forbids.
   *
   * THE HIDDEN LINK IS TIDINESS, NOT SECURITY. `/approvals` and every action
   * behind it refuse independently; nothing here is load-bearing.
   *
   * `/activity` is deliberately NOT changed: the Activity Log grades what a
   * reader may see rather than refusing them, so its screen has an honest
   * answer for every member.
   */
  {
    href: '/approvals',
    key: 'nav.approvals',
    permission: 'content.read',
    icon: <CheckIcon size={20} />,
  },
  /*
   * Phase 6. Gated on `integrations.read`, matching the route exactly: a
   * Viewer (read-only) holds `workspace.read` and nothing else (D-62, D-130),
   * so they never see the entry and would get a 404 if they typed the path.
   * The hidden link is tidiness; the route's own refusal is the control.
   */
  {
    href: '/integrations',
    key: 'nav.integrations',
    permission: 'integrations.read',
    // `SendIcon` reused rather than a new glyph drawn: publishing IS sending,
    // and §4.2 rule 4 puts reuse ahead of creation.
    icon: <SendIcon size={20} />,
  },
  /*
   * Phase 7. Each gated on the permission its route requires, exactly as the
   * Phase 6 entry is: offering a link that answers 404 is the dead link §20
   * forbids, and the route's own refusal is the control.
   *
   * A Viewer (read-only) holds `workspace.read` and nothing else (D-62, D-130),
   * so none of these four ever appears for them — and typing the path answers
   * 404.
   */
  {
    href: '/analytics',
    key: 'nav.analytics',
    permission: 'analytics.read',
    /*
     * EXISTING GLYPHS, NOT NEW ONES. §4.2 rule 4 puts reuse ahead of creation,
     * and each of these four already means the right thing: a pulse is
     * performance over time, a route is a plan, the spark is the Copilot's own
     * mark everywhere else in the product, and sliders are rules somebody set.
     */
    icon: <PulseIcon size={20} />,
  },
  {
    href: '/strategy',
    key: 'nav.strategy',
    permission: 'strategy.read',
    icon: <RouteIcon size={20} />,
  },
  /*
   * PHASE 8 — MARKETING INTELLIGENCE. On the fixed inventory since D-188 and
   * linked now because its screen exists now. Gated on `strategy.read`,
   * matching the route exactly.
   *
   * It reads between Strategy and the Copilot because that is where it sits in
   * the work: the numbers say what happened, intelligence says what that means
   * and what the brand should remember, strategy says what to do about it.
   *
   * `LayersIcon` reused rather than a new glyph drawn (§4.2 rule 4): the whole
   * area is one thing laid over another — what this brand declared, against
   * what it actually published.
   */
  {
    href: '/intelligence',
    key: 'nav.intelligence',
    permission: 'strategy.read',
    icon: <LayersIcon size={20} />,
  },
  {
    href: '/copilot',
    key: 'nav.copilot',
    permission: 'copilot.use',
    icon: <SparkIcon size={20} />,
  },
  {
    href: '/automations',
    key: 'nav.automations',
    permission: 'automation.read',
    icon: <SlidersIcon size={20} />,
  },
  {
    href: '/activity',
    key: 'nav.activity',
    permission: null,
    icon: <ListIcon size={20} />,
  },
  {
    href: '/notifications',
    key: 'nav.notifications',
    permission: null,
    icon: <AlertIcon size={20} />,
  },
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
  customerName,
  permissionKeys,
  availableWorkspaces = [],
  brandContext,
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
  children: ReactNode;
}) {
  const t = translator(locale);
  const other = locale === 'ar' ? 'en' : 'ar';
  const identity = customerName ?? workspaceName;

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
        /*
         * TWO CARDS, ONE STACK — the workspace, then the brand inside it.
         *
         * THE BRAND CARD SITS WHERE THE WORKSPACE CARD ALREADY IS, which is the
         * rail rather than the top bar. The phase brief describes the Workspace
         * Selector as being "in the top bar"; in the implemented product it is
         * `headerStart`, the rail's identity block (D-59), and the top bar
         * carries search, notifications, language and create. Putting the brand
         * selector in the top bar would have separated it from the thing it is
         * scoped BY and introduced the second navigation system the brief
         * forbids, so the stronger instruction — "beside the Workspace
         * Selector" — decides, and the conflict is recorded in
         * docs/UI-FIDELITY-CONTRACT.md §6.
         *
         * The order is containment: a brand lives inside a workspace, so it
         * reads underneath it. Same card, same tile, same two lines.
         */
        <div style={{ display: 'grid', gap: spacingTokens.xs }}>
          <WorkspaceSwitcher
            label={t('ws.switcherLabel')}
            current={{ name: workspaceName, roleName }}
            options={workspaceOptions}
            manageHref={`/${locale}/workspaces`}
            manageLabel={t('nav.switch')}
            manageTestId="switch-workspace"
          />
          {brandContext ? (
            <BrandSwitcher
              label={t('brand.switcherLabel')}
              current={brandTrigger(brandContext, t)}
              options={brandContext.brands.map((brand) => ({
                id: brand.id,
                name: brand.name,
                current: brandContext.selectedValue === brand.id,
              }))}
              action={selectBrandAction}
              hiddenFields={{ locale, next: `/${locale}${activePath ?? '/overview'}` }}
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
          ) : null}
        </div>
      }
      headerEnd={
        /*
         * THE DEMO'S TOP-BAR ACTION SET (§9, §10): search, notifications, the
         * language square and the purple create action. Search and
         * notifications open an honest panel saying they are not connected yet
         * rather than being greyed out — §10 asks for the composition to
         * survive without the functionality being faked.
         */
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
              href={`/${other}${activePath ?? '/overview'}`}
              targetLocale={other}
              targetLabel={other === 'ar' ? 'العربية' : 'English'}
              ariaLabel={t('nav.language')}
            />
          }
        />
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
        reference's top-bar actions are global (search, notifications, create)
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

export const customerTableStyle = (): CSSProperties => ({
  inlineSize: '100%',
  borderCollapse: 'collapse',
  fontSize: typographyTokens.bodySm.fontSize,
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
