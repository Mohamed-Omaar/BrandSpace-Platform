'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  colorTokens,
  layoutTokens,
  motionTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
  zIndexTokens,
} from './tokens';
import { AmbientBackground } from './ambient';
import { ChevronEndIcon, ChevronStartIcon, CloseIcon, MenuIcon } from './icons';
import { Tooltip, useOverlayBehaviour } from './overlays';

/**
 * The responsive application shell shared by the Customer Dashboard and the
 * Control Center.
 *
 * TWO NAVIGATIONS, NOT ONE SHRUNK. On desktop a sidebar that collapses to
 * icons; on a phone a drawer opened from the header. The brief is explicit that
 * the mobile navigation must not be the desktop one made narrow, and the reason
 * is behavioural rather than aesthetic: a 4rem icon rail on a 390px screen eats
 * a sixth of the viewport permanently and still has nowhere to put a tooltip.
 *
 * NAVIGATION IS DATA, NOT A CALLBACK. An earlier version took a `renderLink`
 * function so the host application could supply its own router link. That
 * cannot work: React forbids passing a function across the server/client
 * boundary, and every authenticated page returned a 500 until the end-to-end
 * suite caught it. The shell therefore renders `next/link` itself and receives
 * only serialisable items — an href, a label, an icon ELEMENT (elements do
 * cross the boundary), and the test hook the suites already depend on.
 *
 * WHAT THE COLLAPSE STATE IS AND IS NOT. It is a per-browser display
 * preference in `localStorage`. It is NOT sent to the server, does not enter a
 * cookie, and no route, permission or query depends on it — so it cannot affect
 * authentication or authorization, and a tampered value can at worst give
 * somebody a narrow sidebar. Navigation items are still filtered by permission
 * for convenience only; every page re-checks server-side and answers 404
 * without it (docs/SECURITY.md §4.5).
 */

export interface ShellNavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: ReactNode;
  /** Marks the item active. The caller compares against the current path. */
  readonly active?: boolean;
  readonly badge?: string | undefined;
  /**
   * The page title for the top bar, when the route's own title is longer than
   * its navigation label — "AI model registry" under a nav item reading "AI
   * models". Centralising it beside the route is what lets a layout-rendered
   * shell title sixteen pages it never sees.
   */
  readonly pageTitle?: string | undefined;
  /**
   * Test hook. Supplied by the host application because the two consoles use
   * different conventions and the end-to-end suites already depend on them —
   * renaming a selector to suit a redesign would silently drop the assertion
   * that used it.
   */
  readonly testId?: string | undefined;
  /**
   * A ROUTE THE SHELL KNOWS BUT DOES NOT LIST (D-308). It still names the page
   * in the top bar and still wins the longest-match, but it is not drawn in
   * the rail or the drawer. The Control Center's Simple mode uses it for the
   * Advanced screens: reachable by URL and titled correctly, without putting
   * the technical route list back in the owner's navigation. The customer
   * dashboard never sets it, so its navigation is unchanged.
   */
  readonly hidden?: boolean | undefined;
}

export interface ShellNavSection {
  readonly title?: string | undefined;
  readonly items: readonly ShellNavItem[];
}

export interface AppShellLabels {
  readonly primaryNavigation: string;
  readonly openNavigation: string;
  readonly closeNavigation: string;
  readonly collapseSidebar: string;
  readonly expandSidebar: string;
}

const COLLAPSE_STORAGE_KEY = 'brandspace.sidebar.collapsed';

/**
 * Read the stored collapse preference AFTER mount.
 *
 * Never during render: the server has no `localStorage`, so reading it in the
 * initial render would produce markup the client immediately contradicts. The
 * first paint is always the expanded sidebar, and a stored preference applies
 * on the next frame.
 */
function useCollapsePreference(): readonly [boolean, (next: boolean) => void, boolean] {
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  /*
   * HAS THE READER ALREADY DECIDED?
   *
   * The mount effect below applies the STORED preference, and it necessarily
   * runs after the first paint — which means the toggle is clickable for a
   * frame before it fires. A click landing in that window used to be silently
   * undone by the effect: the sidebar collapsed and then sprang open again.
   *
   * Rare in a browser and rare in a test, but "rare and silent" is the worst
   * kind of bug to leave in a control, so an explicit choice always wins over
   * the stored one. A ref rather than state: reading it must not schedule a
   * render, and it is only ever consulted inside the effect.
   */
  const chosen = useRef(false);

  useEffect(() => {
    setHydrated(true);
    if (chosen.current) return;
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1');
    } catch {
      // A browser with storage disabled is not an error state: the sidebar
      // simply stays expanded for the session.
    }
  }, []);

  const update = useCallback((next: boolean) => {
    chosen.current = true;
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* Preference not persisted; the current session still honours it. */
    }
  }, []);

  return [collapsed, update, hydrated] as const;
}

/**
 * A navigation item.
 *
 * THE ACTIVE ITEM IS AN INK-FILLED PILL WITH INVERTED TEXT (D-59). That single
 * decision is most of what separates the approved direction from the outlined
 * console it replaced: the reference marks the current page by filling its pill
 * near-black and flipping the label white, at 18.85:1, rather than by tinting a
 * row or drawing a bar along its edge.
 *
 * IT IS ALSO THE MOST ACCESSIBLE OPTION HERE, not a trade against one. A tint
 * is a hue change, and `brandPurpleTint` is 1.10:1 against white — below the
 * 3:1 a boundary needs, so it could never have carried the state by itself. A
 * full fill inversion changes luminance, shape and text colour together, and
 * `aria-current="page"` carries the same fact to assistive technology.
 */
function navLinkStyle(active: boolean, collapsed: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    /*
     * `.nav-item { height: 39px; border-radius: 12px; padding: 0 11px;
     *  gap: 11px; font-size: 11px; font-weight: 650; color: #45454b }`
     * and `.nav-item.active { background: var(--ink); color: #fff;
     *  box-shadow: 0 8px 18px rgba(17,17,20,.15) }`.
     *
     * 39px, not 44px. The full demo runs a denser rail than the simplified
     * three-file reference did, and the density is a large part of why it holds
     * twenty-three items in four groups without scrolling.
     */
    gap: layoutTokens.navItemGap,
    justifyContent: collapsed ? 'center' : 'flex-start',
    blockSize: layoutTokens.navItemHeight,
    minBlockSize: layoutTokens.navItemHeight,
    inlineSize: '100%',
    paddingInline: collapsed ? 0 : layoutTokens.navItemPadInline,
    paddingBlock: 0,
    borderRadius: radiusTokens.control,
    textDecoration: 'none',
    ...typographyTokens.navLabel,
    color: active ? colorTokens.inkInk : colorTokens.textSecondary,
    background: active ? colorTokens.ink : 'transparent',
    boxShadow: active ? shadowTokens.navActive : 'none',
    border: '1px solid transparent',
    position: 'relative',
    whiteSpace: 'nowrap',
    transition: `background-color ${motionTokens.fast} ${motionTokens.easeOut}`,
  };
}

function NavLink({
  item,
  collapsed,
  onNavigate,
}: {
  readonly item: ShellNavItem;
  readonly collapsed: boolean;
  readonly onNavigate?: (() => void) | undefined;
}) {
  const active = item.active === true;
  return (
    <Link
      href={item.href}
      data-testid={item.testId}
      // THE LABEL IS ALWAYS THE ACCESSIBLE NAME. Collapsed, the link contains
      // only an `aria-hidden` icon, so without this it has no name at all —
      // axe reports `link-name`, and a screen-reader user hears "link" five
      // times. Expanded, it matches the visible text, which is what WCAG 2.5.3
      // (Label in Name) asks for.
      aria-label={item.label}
      // `aria-current` carries the active state, so it is never signalled by
      // colour alone (WCAG 1.4.1).
      aria-current={active ? 'page' : undefined}
      // Spread rather than `onClick={onNavigate}`: under
      // `exactOptionalPropertyTypes` an explicit `undefined` is not assignable
      // to an optional handler, so the key is omitted entirely instead.
      {...(onNavigate ? { onClick: onNavigate } : {})}
      style={navLinkStyle(active, collapsed)}
    >
      {/*
       * `.nav-icon { width: 20px; display: grid; place-items: center;
       *  font-size: 14px }` — a 20px SLOT holding a ~14px glyph, not a 20px
       * glyph. The demo's rail reads light because its symbols are small
       * inside a generous slot; matching the slot but not the glyph is what
       * made ours look heavier at the same width (§7).
       */}
      <span
        className="bs-nav-icon"
        style={{
          display: 'grid',
          placeItems: 'center',
          inlineSize: layoutTokens.navIconSlot,
          blockSize: layoutTokens.navIconSlot,
          flexShrink: 0,
        }}
      >
        {item.icon}
      </span>
      {collapsed ? null : (
        <span style={{ minInlineSize: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.label}
        </span>
      )}
      {!collapsed && item.badge ? (
        <span
          style={{
            marginInlineStart: 'auto',
            paddingInline: spacingTokens.xs,
            borderRadius: radiusTokens.full,
            background: active ? 'rgba(255, 255, 255, 0.18)' : colorTokens.surfaceMuted,
            ...typographyTokens.caption,
            fontWeight: 700,
            color: active ? colorTokens.inkInk : colorTokens.textSecondary,
          }}
        >
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}

function NavList({
  sections,
  collapsed,
  onNavigate,
}: {
  readonly sections: readonly ShellNavSection[];
  readonly collapsed: boolean;
  readonly onNavigate?: (() => void) | undefined;
}) {
  // Hidden items name pages; they are never drawn (D-308). A section left
  // with nothing to draw is not drawn either, heading included.
  const visible = sections
    .map((section) => ({ ...section, items: section.items.filter((item) => !item.hidden) }))
    .filter((section) => section.items.length > 0);
  return (
    <div style={{ display: 'grid', gap: layoutTokens.navGroupGap }}>
      {visible.map((section, sectionIndex) => (
        <div key={section.title ?? `section-${sectionIndex}`}>
          {/* A section heading is meaningless next to icons with no labels, so
              it is replaced by a divider when collapsed rather than truncated. */}
          {section.title ? (
            collapsed ? (
              <div
                aria-hidden="true"
                style={{
                  blockSize: '1px',
                  background: colorTokens.hairline,
                  marginBlock: spacingTokens.xs,
                  marginInline: spacingTokens.sm,
                }}
              />
            ) : (
              <h2
                style={{
                  // `.nav-group-title { padding: 0 12px 7px; font-size: 9px;
                  //  font-weight: 800; letter-spacing: .08em }`.
                  padding: layoutTokens.navGroupTitlePad,
                  ...typographyTokens.overline,
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                  color: colorTokens.textSubtle,
                }}
              >
                {section.title}
              </h2>
            )
          ) : null}
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              // The demo's nav items sit flush; the group gap does the spacing.
              gap: 0,
            }}
          >
            {section.items.map((item) => (
              <li key={item.href}>
                {/* Collapsed to icons, the label survives only as a tooltip and
                    as the link's accessible name — both, never one. */}
                {collapsed ? (
                  <Tooltip label={item.label} placement="inline-end" stretch>
                    <NavLink item={item} collapsed onNavigate={onNavigate} />
                  </Tooltip>
                ) : (
                  <NavLink item={item} collapsed={false} onNavigate={onNavigate} />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * The navigation item the current URL is on, by longest matching href.
 *
 * WHY THE SHELL RESOLVES THIS. The Control Center's layout renders the shell
 * and its PAGES render their own content, so the layout never learned which
 * route it was on — `activePath` was simply never passed, and the comparison
 * `(activePath ?? '') === item.href` matched the console root on every single
 * page. Every console screen showed "Overview" as the active item.
 *
 * A layout cannot read the pathname on the server, but this shell is already a
 * client component, so it can. A caller that knows better still wins: the
 * customer dashboard sets `item.active` explicitly and that is respected.
 *
 * Longest match, not equality: `/en/console/workspaces/<id>` belongs to the
 * workspaces item, and `/en/console` must not swallow it.
 */
function matchNavItem(
  sections: readonly ShellNavSection[],
  pathname: string | null,
): ShellNavItem | null {
  if (!pathname) return null;
  let best: ShellNavItem | null = null;
  for (const section of sections) {
    for (const item of section.items) {
      if (pathname !== item.href && !pathname.startsWith(`${item.href}/`)) continue;
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  return best;
}

export function AppShell({
  brand,
  sections,
  labels,
  headerStart,
  headerEnd,
  pageEyebrow,
  pageTitle,
  pageDescription,
  pageMeta,
  banner,
  profile,
  children,
  contentMaxWidth = layoutTokens.contentMaxWidth,
}: {
  readonly brand: ReactNode;
  readonly sections: readonly ShellNavSection[];
  readonly labels: AppShellLabels;
  /** Workspace switcher or page context, beside the brand. */
  readonly headerStart?: ReactNode;
  /** Language switcher, notifications, account menu. */
  readonly headerEnd?: ReactNode;
  /**
   * THE PAGE TITLE, AND IT LIVES IN THE TOP BAR.
   *
   * The reference composes `eyebrow → h1 → actions` as one 92px block, and
   * rendering the title below the bar instead is what made every heading read
   * as detached from it. The shell owns the `h1` — there is exactly one per
   * page, it always carries `data-testid="heading"`, and no page has to
   * remember to render one.
   *
   * A page that supplies its own title surface (the Overview's hero) passes no
   * `pageTitle`; it is then responsible for the single `h1`.
   */
  readonly pageEyebrow?: string | undefined;
  readonly pageTitle?: string | undefined;
  readonly pageDescription?: string | undefined;
  /** Status badges that belong beside the page-level actions. */
  readonly pageMeta?: ReactNode;
  /** Support Mode banner — rendered above everything and never scrolled away. */
  readonly banner?: ReactNode;
  /**
   * The signed-in identity, pinned to the foot of the sidebar.
   *
   * In the sidebar rather than the header because the header should stay
   * light: a header carrying brand, workspace, language, notifications, account
   * AND sign-out is the cluttered strip the brief asks to avoid.
   */
  readonly profile?: ReactNode;
  readonly children: ReactNode;
  readonly contentMaxWidth?: string;
}) {
  const pathname = usePathname();
  const matched = matchNavItem(sections, pathname);

  /*
   * The caller's `active` flag wins where it is set; otherwise the shell marks
   * the item the URL is actually on. Same for the title: an explicit
   * `pageTitle` wins, and a route that supplies none falls back to the label of
   * the navigation item it belongs to — which is how sixteen Control Center
   * routes get the reference's top-bar title without each page passing one.
   */
  const resolvedSections: readonly ShellNavSection[] = sections.some((section) =>
    section.items.some((item) => item.active !== undefined),
  )
    ? sections
    : sections.map((section) => ({
        ...section,
        items: section.items.map((item) => ({ ...item, active: item === matched })),
      }));

  const resolvedTitle = pageTitle ?? matched?.pageTitle ?? matched?.label;

  const [collapsed, setCollapsed, hydrated] = useCollapsePreference();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const drawerId = useId();
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useOverlayBehaviour({ open: drawerOpen, onClose: closeDrawer, containerRef: drawerRef });

  // A drawer left open while the viewport grows into desktop would trap focus
  // in a panel nobody can see.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const query = window.matchMedia('(min-width: 768px)');
    const onChange = () => {
      if (query.matches) setDrawerOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [drawerOpen]);

  const sidebarWidth = collapsed ? layoutTokens.sidebarCollapsed : layoutTokens.sidebarExpanded;

  const sidebarBody = (
    <>
      <div
        style={{
          display: 'grid',
          // `.experience-switcher { margin: 9px 0 12px }`.
          gap: '0.5625rem',
          flexShrink: 0,
          marginBlockEnd: '0.75rem',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            // `.app-shell.sidebar-collapsed .sidebar-top { flex-direction:
            //  column; height: 88px }` — the mark stays, the wordmark goes.
            // `.sidebar-top { height: 54px; padding: 0 5px }` and collapsed
            // `{ flex-direction: column; height: 90px; gap: 8px }`.
            flexDirection: collapsed ? 'column' : 'row',
            justifyContent: collapsed ? 'center' : 'space-between',
            gap: spacingTokens.sm,
            blockSize: collapsed ? layoutTokens.railTopHeightCollapsed : layoutTokens.railTopHeight,
            paddingInline: layoutTokens.railTopPadInline,
          }}
        >
          {brand}
          <button
            type="button"
            className="bs-pressable bs-control"
            data-testid="toggle-sidebar"
            aria-label={collapsed ? labels.expandSidebar : labels.collapseSidebar}
            aria-pressed={collapsed}
            onClick={() => setCollapsed(!collapsed)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              // `.icon-button { width: 38px; height: 38px; border-radius: 12px;
              //  background: var(--soft) }`, `.collapse-button { font-size: 17px }`.
              inlineSize: layoutTokens.iconButton,
              blockSize: layoutTokens.iconButton,
              flexShrink: 0,
              borderRadius: radiusTokens.control,
              border: '1px solid transparent',
              color: colorTokens.textPrimary,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {collapsed ? <ChevronEndIcon size={18} /> : <ChevronStartIcon size={18} />}
          </button>
        </div>
        {/* THE WORKSPACE SWITCHER BELONGS AT THE TOP OF THE SIDEBAR, not in the
            header: which workspace you are in scopes everything the navigation
            below it points at, so it reads as the parent of the list. */}
        {headerStart}
      </div>

      {/*
       * `flex-shrink: 0`, AND THIS IS THE WHOLE BUG.
       *
       * The rail is a flex column with a one-viewport minimum. A flex item
       * defaults to `flex-shrink: 1`, so when the Control Center's thirteen
       * items in four groups came to ~840px inside a 760px box, the navigation
       * BOX was squeezed to fit while its content overflowed — straight through
       * the profile block below it. axe read it exactly right, twice over:
       * "partially obscured, smallest space is 244.9px by 8.4px", and "safe
       * clickable space has a diameter of 10.8px". A WCAG 2.5.8 target-size
       * failure on the last link in the rail; half a link is not a target.
       *
       * Refusing to shrink makes the column grow past the viewport instead, and
       * the page scrolls — which is what the reference does.
       */}
      {/* `.nav-list { margin-top: 18px }`. */}
      {/*
       * `.nav-scroll { flex: 1; overflow: auto; padding: 2px 0 10px }`.
       *
       * The NAVIGATION scrolls, not the rail, so the identity card above it and
       * the profile card below it stay put. The rail itself is a fixed
       * viewport-height column (see `.bs-shell > .bs-sidebar` in tokens.css).
       */}
      <div
        style={{
          flex: '1 1 auto',
          minBlockSize: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          paddingBlock: `${spacingTokens['3xs']} 0.625rem`,
          scrollbarWidth: 'none',
        }}
      >
        <NavList sections={resolvedSections} collapsed={collapsed} />
      </div>

      {/* The identity sits at the FOOT, pinned by `margin-block-start: auto`,
          so the navigation and the account never compete for the same corner. */}
      {profile ? (
        <div
          style={{
            // `.sidebar-bottom { padding-top: 8px }`.
            marginBlockStart: 'auto',
            flexShrink: 0,
            paddingBlockStart: spacingTokens.sm,
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            minInlineSize: 0,
          }}
        >
          {profile}
        </div>
      ) : null}
    </>
  );

  return (
    <div
      className="bs-ambient-host"
      data-testid="app-shell"
      data-sidebar-state={hydrated ? (collapsed ? 'collapsed' : 'expanded') : 'expanded'}
    >
      {/* Behind everything, at `z-index: -2`, opaque shell above it. */}
      <AmbientBackground />

      {banner}

      {/*
       * THE SHELL FLOATS. `--bs-shell-sidebar-width` is the only measurement
       * JavaScript supplies, because the collapse state genuinely is dynamic;
       * whether there is a sidebar column at all is decided in CSS at the `md`
       * breakpoint, so the layout does not flicker on first paint or differ
       * between server and client.
       */}
      <div
        className="bs-shell"
        style={{ '--bs-shell-sidebar-width': sidebarWidth } as CSSProperties}
      >
        <nav
          className="bs-sidebar"
          aria-label={labels.primaryNavigation}
          data-testid="sidebar"
          style={{
            display: 'none',
            flexDirection: 'column',
            gap: spacingTokens.xs,
            minInlineSize: 0,
            /*
             * THE RAIL IS AS TALL AS THE PAGE, AND IT DOES NOT SCROLL ITSELF.
             *
             * A minimum of one viewport gives `margin-block-start: auto` on the
             * foot something to push against, and `align-self: stretch` (the
             * grid default) lets it grow with a long page. What it deliberately
             * does NOT have is an internal scroll region, which the reference
             * does not have either.
             *
             * Two earlier attempts had one, and both failed the same way. A
             * scroll container whose last item straddles its bottom edge leaves
             * that item's box overlapping whatever sits below — and the
             * Control Center's thirteen items in four groups do not fit 800px.
             * axe reported it exactly right: "Target has insufficient size
             * because it is partially obscured", a WCAG 2.5.8 failure on the
             * last link in the rail. Half a link is not a target, and no amount
             * of padding inside a scroll container fixes the top scroll
             * position.
             */
            minBlockSize: `calc(100vh - ${layoutTokens.shellInset} * 2)`,
            paddingInline: layoutTokens.railPadInline,
            paddingBlockStart: layoutTokens.railPadBlockStart,
            paddingBlockEnd: layoutTokens.railPadBlockEnd,
            // `.sidebar { background: rgba(250,250,251,.78) }` — translucent,
            // like the shell it sits inside.
            background: colorTokens.shellSidebarAlpha,
          }}
        >
          {sidebarBody}
        </nav>

        <div
          className="bs-panel"
          style={{
            minInlineSize: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/*
           * THE TOP BAR CARRIES THE PAGE TITLE (§4 of the fidelity pass).
           *
           * `<header class="topbar"><div><p class="eyebrow"><h1></div><div
           * class="topbar-actions">` — measured at 1440: 92px tall,
           * `justify-content: space-between`, `align-items: center`, gap 20px,
           * eyebrow at y=41 and the h1 baseline block at y=56.
           *
           * It used to hold only the actions, with the title rendered by
           * `PageHeader` below it. That is what made the heading read as
           * detached from the bar on every route: the reference has one block,
           * not a strip and then a title. The shell owns the `h1` now, so
           * every route gets the same composition without threading a prop
           * through twenty-nine pages.
           */}
          <header
            className="bs-topbar"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              // Keep the title block clear of the shell's rounded top edge.
              // The description can make the bar taller than its minimum height, so relying on
              // vertical centring alone lets the eyebrow sit against the top on content-heavy pages.
              gap: layoutTokens.topbarGap,
              rowGap: spacingTokens.sm,
              minBlockSize: layoutTokens.headerHeight,
              paddingInline: layoutTokens.panelPadInline,
              paddingBlockStart: spacingTokens.md,
              paddingBlockEnd: '0.75rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: spacingTokens.sm,
                minInlineSize: 0,
                flex: '1 1 16rem',
              }}
            >
              <button
                type="button"
                className="bs-drawer-trigger bs-control"
                aria-label={labels.openNavigation}
                aria-expanded={drawerOpen}
                aria-controls={drawerId}
                data-testid="open-navigation"
                onClick={() => setDrawerOpen(true)}
                style={{
                  display: 'none',
                  alignItems: 'center',
                  justifyContent: 'center',
                  inlineSize: layoutTokens.iconButton,
                  blockSize: layoutTokens.iconButton,
                  flexShrink: 0,
                  borderRadius: radiusTokens.md,
                  color: colorTokens.textPrimary,
                  cursor: 'pointer',
                }}
              >
                <MenuIcon size={20} />
              </button>

              {resolvedTitle ? (
                <div style={{ minInlineSize: 0 }}>
                  {pageEyebrow ? (
                    <p
                      data-testid="page-eyebrow"
                      style={{
                        // `.eyebrow { margin: 0 0 4px }`.
                        margin: 0,
                        marginBlockEnd: spacingTokens.xs,
                        ...typographyTokens.overline,
                        textTransform: 'uppercase',
                        color: colorTokens.textMuted,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {pageEyebrow}
                    </p>
                  ) : null}
                  <h1
                    data-testid="heading"
                    style={{
                      // `.topbar h1 { margin: 0 }` — the eyebrow owns the gap.
                      margin: 0,
                      ...typographyTokens.h1,
                      color: colorTokens.textPrimary,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {resolvedTitle}
                  </h1>
                  {pageDescription ? (
                    <p
                      data-testid="description"
                      style={{
                        margin: 0,
                        marginBlockStart: spacingTokens.xs,
                        maxInlineSize: '62ch',
                        ...typographyTokens.bodySm,
                        color: colorTokens.textSecondary,
                      }}
                    >
                      {pageDescription}
                    </p>
                  ) : null}
                </div>
              ) : (
                /* Below `md` the sidebar is gone, so the brand has nowhere else
                   to live. Above it, the sidebar already shows it. */
                <span className="bs-narrow-only" style={{ minInlineSize: 0 }}>
                  {brand}
                </span>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                // `.topbar-actions { gap: 7px }`.
                gap: layoutTokens.topbarActionGap,
                // D-304 — a labelled Copilot control is wider than a square; on
                // the narrowest phones the row wraps rather than overhangs.
                flexWrap: 'wrap',
                minInlineSize: 0,
                flexShrink: 0,
              }}
            >
              {pageMeta}
              {headerEnd}
            </div>
          </header>

          <main
            id="main"
            style={{
              flex: '1 1 auto',
              minInlineSize: 0,
              paddingInline: layoutTokens.panelPadInline,
              paddingBlockEnd: layoutTokens.panelPadBlockEnd,
            }}
          >
            <div
              className="bs-page-flow"
              style={{ maxInlineSize: contentMaxWidth, marginInline: 'auto' }}
            >
              {children}
            </div>
          </main>
        </div>
      </div>

      {drawerOpen ? (
        <div
          data-testid="navigation-scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDrawer();
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: zIndexTokens.drawer,
            background: 'rgba(12, 12, 14, 0.25)',
          }}
        >
          <div
            id={drawerId}
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={labels.primaryNavigation}
            data-testid="navigation-drawer"
            tabIndex={-1}
            style={{
              position: 'absolute',
              insetBlock: 0,
              insetInlineStart: 0,
              inlineSize: 'min(19rem, 88vw)',
              background: colorTokens.surface,
              borderStartEndRadius: radiusTokens['2xl'],
              borderEndEndRadius: radiusTokens['2xl'],
              boxShadow: shadowTokens.overlay,
              padding: spacingTokens.md,
              overflowY: 'auto',
              display: 'grid',
              gap: spacingTokens.md,
              alignContent: 'start',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacingTokens.sm,
              }}
            >
              {brand}
              <button
                type="button"
                className="bs-control"
                aria-label={labels.closeNavigation}
                data-testid="close-navigation"
                onClick={closeDrawer}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  inlineSize: '2.5rem',
                  blockSize: '2.5rem',
                  borderRadius: radiusTokens.md,
                  color: colorTokens.textPrimary,
                  cursor: 'pointer',
                }}
              >
                <CloseIcon size={20} />
              </button>
            </div>
            {headerStart}
            {/* Never collapsed in the drawer: the whole point of the drawer is
                that there is room for labels. */}
            <NavList sections={resolvedSections} collapsed={false} onNavigate={closeDrawer} />
            {profile}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The official BrandSpace mark, shared by shell, auth and metadata surfaces. */
export function BrandGlyph({ size = layoutTokens.brandMark }: { readonly size?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="brand-mark"
      style={{
        display: 'inline-flex',
        inlineSize: size,
        blockSize: size,
        flexShrink: 0,
      }}
    >
      <svg
        viewBox="0 0 877.07 877.07"
        width="100%"
        height="100%"
        focusable="false"
        aria-hidden="true"
      >
        <path
          fill="#000000"
          d="M615.98 877.07H261.09C116.89 877.07 0 760.18 0 615.98V261.09C0 116.89 116.89 0 261.09 0h354.89c144.2 0 261.09 116.89 261.09 261.09v354.89c0 144.2-116.89 261.09-261.09 261.09z"
        />
        <path
          fill="#FFFFFF"
          d="M555.77 680.25c-112.22 0-224.43 0-336.65 0-.16-.99-.45-1.99-.45-2.98-.06-159.21-.09-318.42-.12-477.63 0-.9.08-1.8.13-2.83h3.94c104.11.03 208.22.02 312.34.13 13.4.01 26.69 1.43 39.65 5.12 22.03 6.27 40.24 18.01 52.92 37.44 13.44 20.59 17.97 43.61 18.03 67.78 0 .83-.55 1.8-1.12 2.48-6.09 7.23-12.25 14.39-18.35 21.61-18.58 21.99-37.14 44-55.7 66.01-.48.57-1.11 1.28-1.13 1.94-.11 3.74-.05 7.49-.05 11.37h5.23c13.8-.04 26.95 2.88 39.11 9.43 22.82 12.29 37.3 31.07 42.94 56.47.88 3.98 1.36 8.04 2.03 12.07v86.24c-.13.58-.29 1.15-.39 1.73-1.16 7.1-1.75 14.35-3.57 21.27-6.18 23.48-18.97 42.81-37.9 58.03-15.24 12.26-32.56 19.84-51.88 22.87-3 .47-6.01.97-9.01 1.45zM366.47 390.4c.73.04 1.24.08 1.75.08 40.44.02 80.87.05 121.31.03 8.77 0 16.33-5.65 18.14-14.27.97-4.63.51-9.56.74-14.36.52-11.1-8.64-19.85-19.78-19.8-39.75.16-79.5.11-119.25.13h-2.91v48.19zm-.08 144.65c.61.03 1.1.08 1.6.08 40.61-.02 81.22 0 121.83-.08 9.65-.02 17.77-7.82 18.39-17.42.23-3.51-.02-7.06.17-10.58.61-11.46-8.23-20.47-20.26-20.44-39.66.1-79.33.01-118.99-.01h-2.74v48.45z"
        />
      </svg>
    </span>
  );
}

/** The BrandSpace wordmark used in both shells. */
export function BrandMark({
  title,
  subtitle,
}: {
  readonly title: string;
  readonly subtitle?: string | undefined;
}) {
  return (
    <span
      data-testid="brand"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        // `.brand { gap: 10px }`.
        gap: layoutTokens.brandGap,
        minInlineSize: 0,
      }}
    >
      <BrandGlyph />
      {/* Tagged so a collapsed rail can drop the wordmark and keep the mark,
          like `.app-shell.sidebar-collapsed .brand-name`. A class rather than a
          positional selector: `> span:last-child` is a guess about structure,
          and it was wrong. */}
      <span className="bs-brand-text" style={{ display: 'grid', minInlineSize: 0 }}>
        <span
          style={{
            // `.brand { font-size: 16px; font-weight: 850 }`, no tracking.
            ...typographyTokens.wordmark,
            color: colorTokens.textPrimary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </span>
        {subtitle ? (
          <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}
