'use client';

import Link from 'next/link';

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
   * Test hook. Supplied by the host application because the two consoles use
   * different conventions and the end-to-end suites already depend on them —
   * renaming a selector to suit a redesign would silently drop the assertion
   * that used it.
   */
  readonly testId?: string | undefined;
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
    gap: spacingTokens.sm,
    justifyContent: collapsed ? 'center' : 'flex-start',
    // 44px: the reference's nav height, and the WCAG 2.5.8 comfortable target.
    minBlockSize: layoutTokens.controlHeight,
    paddingInline: collapsed ? 0 : spacingTokens.sm,
    paddingBlock: spacingTokens.xs,
    borderRadius: radiusTokens.md,
    textDecoration: 'none',
    ...typographyTokens.bodySm,
    fontWeight: active ? 650 : 550,
    color: active ? colorTokens.inkInk : colorTokens.textSecondary,
    background: active ? colorTokens.ink : 'transparent',
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
      <span style={{ display: 'inline-flex', flexShrink: 0 }}>{item.icon}</span>
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
  return (
    <div style={{ display: 'grid', gap: spacingTokens.md }}>
      {sections.map((section, sectionIndex) => (
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
                  paddingInline: spacingTokens.sm,
                  marginBlockEnd: spacingTokens.xs,
                  ...typographyTokens.overline,
                  textTransform: 'uppercase',
                  color: colorTokens.textMuted,
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
              gap: spacingTokens['3xs'],
            }}
          >
            {section.items.map((item) => (
              <li key={item.href}>
                {/* Collapsed to icons, the label survives only as a tooltip and
                    as the link's accessible name — both, never one. */}
                {collapsed ? (
                  <Tooltip label={item.label} placement="inline-end">
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

export function AppShell({
  brand,
  sections,
  labels,
  headerStart,
  headerEnd,
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
      <div style={{ display: 'grid', gap: spacingTokens.sm, marginBlockEnd: spacingTokens.md }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'space-between',
            gap: spacingTokens.xs,
            minBlockSize: '2.625rem',
          }}
        >
          {collapsed ? null : brand}
          <button
            type="button"
            className="bs-pressable"
            data-testid="toggle-sidebar"
            aria-label={collapsed ? labels.expandSidebar : labels.collapseSidebar}
            aria-pressed={collapsed}
            onClick={() => setCollapsed(!collapsed)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              inlineSize: '2.5rem',
              blockSize: '2.5rem',
              flexShrink: 0,
              borderRadius: radiusTokens.md,
              border: '1px solid transparent',
              background: 'transparent',
              color: colorTokens.textMuted,
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

      <NavList sections={sections} collapsed={collapsed} />

      {/* The identity sits at the FOOT, pinned by `margin-block-start: auto`,
          so the navigation and the account never compete for the same corner. */}
      {profile ? (
        <div
          style={{
            marginBlockStart: 'auto',
            paddingBlockStart: spacingTokens.md,
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
            position: 'sticky',
            insetBlockStart: 0,
            alignSelf: 'start',
            /*
             * A FIXED HEIGHT, not a content height. The profile at the foot is
             * pinned with `margin-block-start: auto`, which does nothing at all
             * unless the column it sits in is taller than its content — the
             * sign-out button was landing directly under the last navigation
             * item instead of at the bottom of the rail.
             *
             * `100vh` less the shell's inset on both sides, matching the shell
             * itself. The rail scrolls inside this box if the navigation ever
             * outgrows it.
             */
            blockSize: `calc(100vh - ${layoutTokens.shellInset} * 2)`,
            overflowY: 'auto',
            overflowX: 'hidden',
            paddingInline: spacingTokens.sm,
            paddingBlock: spacingTokens.md,
            background: colorTokens.shellSidebar,
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
            background: colorTokens.shellPanel,
          }}
        >
          {/*
           * A LIGHT TOP BAR. No border, no fill of its own, no shadow — §7. It
           * carries the drawer trigger on a phone and the page-level actions
           * everywhere; the page title itself is rendered by `PageHeader`
           * immediately below, at display scale.
           */}
          <header
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: spacingTokens.sm,
              rowGap: spacingTokens.xs,
              minBlockSize: layoutTokens.headerHeight,
              paddingInline: spacingTokens.lg,
              paddingBlock: spacingTokens.sm,
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
                inlineSize: '2.5rem',
                blockSize: '2.5rem',
                flexShrink: 0,
                borderRadius: radiusTokens.md,
                color: colorTokens.textPrimary,
                cursor: 'pointer',
              }}
            >
              <MenuIcon size={20} />
            </button>

            {/* Below `md` the sidebar is gone, so the brand has nowhere else to
                live. Above it, the sidebar already shows it and a second copy
                would be a duplicate landmark. */}
            <span className="bs-narrow-only" style={{ minInlineSize: 0 }}>
              {brand}
            </span>

            <div
              style={{
                marginInlineStart: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: spacingTokens.sm,
                minInlineSize: 0,
              }}
            >
              {headerEnd}
            </div>
          </header>

          <main
            id="main"
            style={{
              flex: '1 1 auto',
              minInlineSize: 0,
              paddingInline: spacingTokens.lg,
              paddingBlockEnd: spacingTokens['2xl'],
            }}
          >
            <div style={{ maxInlineSize: contentMaxWidth, marginInline: 'auto' }}>{children}</div>
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
            <NavList sections={sections} collapsed={false} onNavigate={closeDrawer} />
            {profile}
          </div>
        </div>
      ) : null}
    </div>
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
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: spacingTokens.sm,
        minInlineSize: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          inlineSize: '1.875rem',
          blockSize: '1.875rem',
          // INK, not purple. In the approved direction the mark is near-black
          // like every other filled surface, and the brand colours are reserved
          // for the ambient background — that restraint is the direction.
          borderRadius: radiusTokens.sm,
          background: colorTokens.ink,
          color: colorTokens.inkInk,
          ...typographyTokens.label,
          fontWeight: 800,
          flexShrink: 0,
        }}
      >
        B
      </span>
      <span style={{ display: 'grid', minInlineSize: 0 }}>
        <span
          style={{
            fontSize: '1rem',
            lineHeight: '1.25rem',
            fontWeight: 800,
            letterSpacing: '-0.02em',
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
