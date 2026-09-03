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

  useEffect(() => {
    setHydrated(true);
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1');
    } catch {
      // A browser with storage disabled is not an error state: the sidebar
      // simply stays expanded for the session.
    }
  }, []);

  const update = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* Preference not persisted; the current session still honours it. */
    }
  }, []);

  return [collapsed, update, hydrated] as const;
}

function navLinkStyle(active: boolean, collapsed: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: spacingTokens.sm,
    justifyContent: collapsed ? 'center' : 'flex-start',
    // WCAG 2.2 target size (2.5.8): never below the minimum pointer target.
    minBlockSize: '2.25rem',
    paddingInline: collapsed ? 0 : spacingTokens.sm,
    paddingBlock: spacingTokens.xs,
    borderRadius: radiusTokens.md,
    textDecoration: 'none',
    ...typographyTokens.bodySm,
    fontWeight: active ? 650 : 500,
    color: active ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
    background: active ? colorTokens.brandPurpleTint : 'transparent',
    // The active item carries THREE signals, not one: a purple tint, a purple
    // label, and a yellow accent mark on the inline-start edge. Colour alone
    // would fail WCAG 1.4.1, and `aria-current` below carries it for a screen
    // reader.
    borderInlineStart: active ? `3px solid ${colorTokens.brandYellow}` : '3px solid transparent',
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
            background: colorTokens.surfaceMuted,
            ...typographyTokens.caption,
            color: colorTokens.textSecondary,
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
                  background: colorTokens.cardBorder,
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

  return (
    <div
      data-testid="app-shell"
      data-sidebar-state={hydrated ? (collapsed ? 'collapsed' : 'expanded') : 'expanded'}
      style={{ minBlockSize: '100vh', background: colorTokens.appBackground }}
    >
      {banner}

      <header
        style={{
          position: 'sticky',
          insetBlockStart: 0,
          zIndex: zIndexTokens.sticky,
          display: 'flex',
          alignItems: 'center',
          // WRAPS. At 390px the brand, the workspace switcher, the language
          // switcher and sign-out cannot share one row, and a non-wrapping
          // header simply pushed the page sideways by 79px.
          flexWrap: 'wrap',
          gap: spacingTokens.sm,
          rowGap: spacingTokens.xs,
          minBlockSize: layoutTokens.headerHeight,
          paddingInline: spacingTokens.md,
          paddingBlock: spacingTokens.xs,
          background: colorTokens.surface,
          borderBlockEnd: `1px solid ${colorTokens.cardBorder}`,
        }}
      >
        {/* The drawer trigger exists only below `md`; the CSS class is defined
            in tokens.css so no JavaScript decides the layout. */}
        <button
          type="button"
          className="bs-drawer-trigger"
          aria-label={labels.openNavigation}
          aria-expanded={drawerOpen}
          aria-controls={drawerId}
          data-testid="open-navigation"
          onClick={() => setDrawerOpen(true)}
          style={{
            display: 'none',
            alignItems: 'center',
            justifyContent: 'center',
            inlineSize: '2.25rem',
            blockSize: '2.25rem',
            borderRadius: radiusTokens.md,
            border: `1px solid ${colorTokens.borderStrong}`,
            background: colorTokens.surface,
            color: colorTokens.textPrimary,
            cursor: 'pointer',
          }}
        >
          <MenuIcon size={20} />
        </button>

        <div
          style={{ display: 'flex', alignItems: 'center', gap: spacingTokens.sm, minInlineSize: 0 }}
        >
          {brand}
          {headerStart}
        </div>
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

      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <nav
          className="bs-sidebar"
          aria-label={labels.primaryNavigation}
          data-testid="sidebar"
          style={{
            display: 'none',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: spacingTokens.md,
            inlineSize: sidebarWidth,
            flex: `0 0 ${sidebarWidth}`,
            position: 'sticky',
            insetBlockStart: layoutTokens.headerHeight,
            blockSize: `calc(100vh - ${layoutTokens.headerHeight})`,
            overflowY: 'auto',
            padding: spacingTokens.sm,
            background: colorTokens.surface,
            borderInlineEnd: `1px solid ${colorTokens.cardBorder}`,
            transition: `inline-size ${motionTokens.base} ${motionTokens.easeOut}`,
          }}
        >
          <NavList sections={sections} collapsed={collapsed} />

          <button
            type="button"
            data-testid="toggle-sidebar"
            aria-label={collapsed ? labels.expandSidebar : labels.collapseSidebar}
            aria-pressed={collapsed}
            onClick={() => setCollapsed(!collapsed)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: collapsed ? 'center' : 'flex-start',
              gap: spacingTokens.sm,
              minBlockSize: '2.25rem',
              paddingInline: collapsed ? 0 : spacingTokens.sm,
              borderRadius: radiusTokens.md,
              border: `1px solid ${colorTokens.cardBorder}`,
              background: colorTokens.surface,
              color: colorTokens.textSecondary,
              cursor: 'pointer',
              fontFamily: 'inherit',
              ...typographyTokens.caption,
            }}
          >
            {/* Logical chevrons: `ChevronStart` points toward the inline start,
                so the control reads correctly in Arabic without a second icon. */}
            {collapsed ? <ChevronEndIcon size={18} /> : <ChevronStartIcon size={18} />}
            {collapsed ? null : <span>{labels.collapseSidebar}</span>}
          </button>
        </nav>

        <main
          id="main"
          style={{
            flex: '1 1 auto',
            minInlineSize: 0,
            padding: spacingTokens.lg,
            paddingBlockEnd: spacingTokens['2xl'],
          }}
        >
          <div style={{ maxInlineSize: contentMaxWidth, marginInline: 'auto' }}>{children}</div>
        </main>
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
            background: 'rgba(15, 23, 42, 0.45)',
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
              inlineSize: 'min(18rem, 85vw)',
              background: colorTokens.surface,
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
                aria-label={labels.closeNavigation}
                data-testid="close-navigation"
                onClick={closeDrawer}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  inlineSize: '2.25rem',
                  blockSize: '2.25rem',
                  borderRadius: radiusTokens.md,
                  border: `1px solid ${colorTokens.borderStrong}`,
                  background: colorTokens.surface,
                  color: colorTokens.textPrimary,
                  cursor: 'pointer',
                }}
              >
                <CloseIcon size={20} />
              </button>
            </div>
            {/* Never collapsed in the drawer: the whole point of the drawer is
                that there is room for labels. */}
            <NavList sections={sections} collapsed={false} onNavigate={closeDrawer} />
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
          inlineSize: '1.75rem',
          blockSize: '1.75rem',
          borderRadius: radiusTokens.md,
          background: colorTokens.brandPurple,
          color: colorTokens.brandPurpleInk,
          ...typographyTokens.label,
          flexShrink: 0,
        }}
      >
        B
      </span>
      <span style={{ display: 'grid', minInlineSize: 0 }}>
        <span
          style={{
            ...typographyTokens.h3,
            color: colorTokens.textPrimary,
            whiteSpace: 'nowrap',
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
