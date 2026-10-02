'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { AmbientBackground } from './ambient';
import {
  BrandGlyph,
  useCollapsePreference,
  usePageEnterGate,
  type AppShellLabels,
} from './app-shell';
import { CloseIcon, MenuIcon } from './icons';
import { prefersReducedMotion } from './motion';
import { usePresence } from './motion-hooks';
import { Tooltip, useOverlayBehaviour } from './overlays';
import { PrototypeIcon } from './prototype-icons';
import {
  colorTokens,
  motionMs,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  zIndexTokens,
} from './tokens';

/**
 * THE CUSTOMER APPLICATION'S SHELL, PORTED FROM `prototype-2026-09-27` (D-468).
 *
 * The frame, the rail and the top bar are the prototype's own markup
 * (`Main.dc.html` lines 79–191), class for class, with its stylesheet in
 * `prototype.css`. What the prototype draws is drawn the way it draws it; what
 * this component adds is only what a static artboard does not need and a real
 * application does:
 *
 *   - NAVIGATION IS LINKS, not buttons that switch a state. Each one is a real
 *     address, `aria-current` marks the page, and the collapsed rail keeps the
 *     label as the accessible name and a keyboard-reachable tooltip.
 *   - THE PHONE WIDTH (below 768px) keeps the product's existing drawer and
 *     full-window layout, because the owner moved the phone layout to
 *     post-launch (D-468 (b)). Every test hook the drawer had, it still has.
 *   - THE COLLAPSE STATE, the page-entrance gate and the gliding pill are the
 *     same per-browser behaviour the design system's shell already had
 *     (`useCollapsePreference`, `usePageEnterGate`, MO2), reused rather than
 *     written twice.
 *
 * Every hook the suites already read is kept: `app-shell`, `sidebar`,
 * `toggle-sidebar`, `open-navigation`, `navigation-drawer`, `navigation-scrim`,
 * `close-navigation`, `nav-pill-rail`, `heading`, `page-eyebrow`,
 * `description`, `brand` and `brand-mark`; the frame still answers to
 * `.bs-shell`, the rail to `.bs-sidebar` and the bar to `.bs-topbar`.
 *
 * The Control Center keeps `AppShell`. Nothing here is shared with it.
 */

/** A rail count: the prototype draws four kinds. */
export interface CustomerNavCount {
  readonly text: string;
  /** `ink` approvals · `bad` failed publishing · `brand` unread notes · `quiet` team size. */
  readonly tone: 'ink' | 'bad' | 'brand' | 'quiet';
  /** What the count means, for the link's accessible name. */
  readonly label: string;
}

export interface CustomerNavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly active?: boolean;
  readonly testId?: string | undefined;
  readonly count?: CustomerNavCount | undefined;
}

export interface CustomerNavSection {
  readonly title?: string | undefined;
  readonly items: readonly CustomerNavItem[];
}

/*
 * MO2 — WHERE THE PILL LAST STOOD in this document, so the next page's pill
 * starts there and glides (`.navInd`, 440 ms). The first placement appears.
 */
let lastPill: { x: number; y: number; w: number; h: number } | null = null;

function useRailPill(
  navRef: React.RefObject<HTMLElement | null>,
  pillRef: React.RefObject<HTMLSpanElement | null>,
  activeHref: string | undefined,
  track: boolean,
): void {
  const placedOnce = useRef(false);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return undefined;
    const measure = () => {
      const link = nav.querySelector<HTMLElement>('a[aria-current="page"]');
      if (!link) return null;
      // `placeNavInd`: offsets inside the nav, plus its own scroll.
      return {
        x: link.offsetLeft,
        y: link.offsetTop,
        w: link.offsetWidth,
        h: link.offsetHeight,
      };
    };
    const put = (at: { x: number; y: number; w: number; h: number }, glide: boolean) => {
      pill.style.transition = glide && !prefersReducedMotion() ? '' : 'none';
      pill.style.transform = `translate(${at.x}px, ${at.y}px)`;
      pill.style.width = `${at.w}px`;
      pill.style.height = `${at.h}px`;
    };
    const target = measure();
    if (!target) {
      nav.removeAttribute('data-ind');
      return undefined;
    }
    if (!placedOnce.current && lastPill && track) {
      put(lastPill, false);
      void pill.offsetWidth;
      put(target, true);
    } else {
      put(target, placedOnce.current);
    }
    placedOnce.current = true;
    nav.setAttribute('data-ind', '1');
    if (track) lastPill = target;

    let placed = target;
    const observer = new ResizeObserver(() => {
      const now = measure();
      if (!now) return;
      const moved =
        Math.abs(now.x - placed.x) +
        Math.abs(now.y - placed.y) +
        Math.abs(now.w - placed.w) +
        Math.abs(now.h - placed.h);
      if (moved < 0.5) return;
      put(now, false);
      placed = now;
      if (track) lastPill = now;
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, [navRef, pillRef, activeHref, track]);
}

function RailLink({
  item,
  collapsed,
  onNavigate,
}: {
  readonly item: CustomerNavItem;
  readonly collapsed: boolean;
  readonly onNavigate?: (() => void) | undefined;
}) {
  const name = item.count ? `${item.label}, ${item.count.label}` : item.label;
  const link = (
    <Link
      href={item.href}
      className="bsp-nav"
      data-testid={item.testId}
      aria-label={name}
      aria-current={item.active ? 'page' : undefined}
      {...(collapsed ? {} : { title: item.label })}
      {...(onNavigate ? { onClick: onNavigate } : {})}
    >
      {item.icon}
      <span className="bsp-nl bs-nav-label">{item.label}</span>
      {item.count ? (
        <span
          className={item.count.tone === 'quiet' ? 'bsp-cnt bsp-nl' : 'bsp-cnt'}
          data-tone={item.count.tone}
          aria-hidden="true"
        >
          {item.count.text}
        </span>
      ) : null}
    </Link>
  );
  return collapsed ? (
    <Tooltip label={item.label} placement="inline-end" stretch>
      {link}
    </Tooltip>
  ) : (
    link
  );
}

function RailNav({
  sections,
  collapsed,
  label,
  onNavigate,
  scope,
}: {
  readonly sections: readonly CustomerNavSection[];
  readonly collapsed: boolean;
  readonly label: string;
  readonly onNavigate?: (() => void) | undefined;
  readonly scope: 'rail' | 'drawer';
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);
  const activeHref = sections.flatMap((section) => section.items).find((item) => item.active)?.href;
  useRailPill(navRef, pillRef, activeHref, scope === 'rail');
  const groupId = useId();
  return (
    <nav ref={navRef} aria-label={label} className="bsp-sbnav">
      <span
        ref={pillRef}
        className="bsp-nav-ind"
        aria-hidden="true"
        data-testid={`nav-pill-${scope}`}
      />
      {sections.map((section, index) => (
        <div
          key={section.title ?? `section-${index}`}
          role="group"
          {...(section.title ? { 'aria-labelledby': `${groupId}-${index}` } : {})}
          style={{ display: 'contents' }}
        >
          {section.title ? (
            <div id={`${groupId}-${index}`} className="bsp-grp bsp-nl">
              <bdi>{section.title}</bdi>
            </div>
          ) : null}
          {section.items.map((item) => (
            <RailLink key={item.href} item={item} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </div>
      ))}
    </nav>
  );
}

export function CustomerShell({
  wordmark,
  sections,
  labels,
  brandCard,
  profile,
  pageEyebrow,
  pageTitle,
  pageDescription,
  pageMeta,
  actions,
  fab,
  banner,
  children,
}: {
  readonly wordmark: string;
  readonly sections: readonly CustomerNavSection[];
  readonly labels: AppShellLabels;
  /** The rail's brand / business card, under the logo. */
  readonly brandCard?: ReactNode;
  /** The user card at the foot of the rail, with its menu. */
  readonly profile?: ReactNode;
  readonly pageEyebrow?: string | undefined;
  readonly pageTitle: string;
  readonly pageDescription?: string | undefined;
  readonly pageMeta?: ReactNode;
  /** The top bar's controls: notes, notifications, language, Create. */
  readonly actions?: ReactNode;
  /** The floating Copilot. */
  readonly fab?: ReactNode;
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}) {
  const pathname = usePathname();
  usePageEnterGate();
  const [collapsed, setCollapsed, hydrated] = useCollapsePreference();
  const [sidebarMotion, setSidebarMotion] = useState(false);
  const motionTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(motionTimer.current), []);
  const toggle = useCallback(() => {
    setCollapsed(!collapsed);
    window.clearTimeout(motionTimer.current);
    if (prefersReducedMotion()) {
      setSidebarMotion(false);
      return;
    }
    // `transition: grid-template-columns .38s` — present only after a click.
    setSidebarMotion(true);
    motionTimer.current = window.setTimeout(() => setSidebarMotion(false), motionMs.collapse + 50);
  }, [collapsed, setCollapsed]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const drawerId = useId();
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  useOverlayBehaviour({ open: drawerOpen, onClose: closeDrawer, containerRef: drawerRef });
  const drawer = usePresence(drawerOpen, drawerRef);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const query = window.matchMedia('(min-width: 768px)');
    const onChange = () => {
      if (query.matches) setDrawerOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [drawerOpen]);

  // `sbW = s.sbMin ? '76px' : '250px'`.
  const sidebarWidth = collapsed ? '76px' : '250px';
  // `sbArrow`: the chevron points to the start edge, and flips when collapsed.
  const arrow = collapsed ? 'scaleX(-1)' : 'none';

  const logo = (
    <span
      data-testid="brand"
      style={{ display: 'flex', alignItems: 'center', gap: '10px', flexGrow: 1, minInlineSize: 0 }}
    >
      <span className="bsp-sb-logo-mark">
        <BrandGlyph size="34px" />
      </span>
      <span className="bsp-sb-wordmark bsp-nl bs-brand-text bsp-ltr">{wordmark}</span>
    </span>
  );

  return (
    <div
      className="bs-ambient-host"
      data-testid="app-shell"
      data-sidebar-state={hydrated ? (collapsed ? 'collapsed' : 'expanded') : 'expanded'}
      {...(sidebarMotion ? { 'data-sidebar-motion': '' } : {})}
    >
      <AmbientBackground />
      {banner}
      <div
        className="bs-shell bsp-frame"
        style={{ '--bs-shell-sidebar-width': sidebarWidth } as CSSProperties}
      >
        <aside
          className={collapsed ? 'bs-sidebar bsp-sb bsp-min' : 'bs-sidebar bsp-sb'}
          data-testid="sidebar"
        >
          <div className="bsp-sb-top">
            <div className="bsp-sb-logo">
              {logo}
              <button
                type="button"
                className="bsp-ibtn bsp-sbt"
                data-testid="toggle-sidebar"
                aria-label={collapsed ? labels.expandSidebar : labels.collapseSidebar}
                title={collapsed ? labels.expandSidebar : labels.collapseSidebar}
                aria-pressed={collapsed}
                onClick={toggle}
              >
                <PrototypeIcon glyph="chevron" size={16} stroke={2} style={{ transform: arrow }} />
              </button>
            </div>
            {brandCard ? <div style={{ position: 'relative' }}>{brandCard}</div> : null}
          </div>
          <RailNav
            sections={sections}
            collapsed={collapsed}
            label={labels.primaryNavigation}
            scope="rail"
          />
          <div className="bsp-sb-foot">
            {profile ? <div style={{ position: 'relative' }}>{profile}</div> : null}
          </div>
        </aside>

        <div className="bs-panel bsp-main">
          <header className="bs-topbar bsp-header">
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: spacingTokens.sm,
                minInlineSize: 0,
              }}
            >
              <button
                type="button"
                className="bs-drawer-trigger bsp-ibtn"
                aria-label={labels.openNavigation}
                aria-expanded={drawerOpen}
                aria-controls={drawerId}
                data-testid="open-navigation"
                onClick={() => setDrawerOpen(true)}
                style={{ display: 'none' }}
              >
                <MenuIcon size={20} />
              </button>
              <div className="bsp-header-title">
                {pageEyebrow ? (
                  <span className="bsp-lbl" data-testid="page-eyebrow">
                    {pageEyebrow}
                  </span>
                ) : null}
                <h1 className="bsp-h1" data-testid="heading" style={{ overflowWrap: 'anywhere' }}>
                  {pageTitle}
                </h1>
                {pageDescription ? (
                  <p className="bsp-sub" data-testid="description">
                    {pageDescription}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="bsp-actions">
              {pageMeta}
              {actions}
            </div>
          </header>
          <main id="main" className="bsp-scroll">
            {/* MO1: keyed by the path, so a page change enters and a re-render does not. */}
            <div key={pathname ?? ''} className="bs-page-flow bsp-page">
              {children}
            </div>
          </main>
        </div>
      </div>

      {fab}

      {drawer.present ? (
        <div
          data-testid="navigation-scrim"
          {...(drawer.leaving ? { 'data-leaving': '', 'aria-hidden': true, inert: true } : {})}
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
            className="bs-pop bsp-sb"
            data-origin="start"
            style={{
              position: 'absolute',
              insetBlock: 0,
              insetInlineStart: 0,
              inlineSize: 'min(19rem, 88vw)',
              background: colorTokens.surface,
              borderStartEndRadius: radiusTokens['2xl'],
              borderEndEndRadius: radiusTokens['2xl'],
              boxShadow: shadowTokens.overlay,
              overflowY: 'auto',
              display: 'grid',
              alignContent: 'start',
            }}
          >
            <div className="bsp-sb-top">
              <div className="bsp-sb-logo">
                {logo}
                <button
                  type="button"
                  className="bsp-ibtn bsp-sbt"
                  aria-label={labels.closeNavigation}
                  data-testid="close-navigation"
                  onClick={closeDrawer}
                >
                  <CloseIcon size={16} />
                </button>
              </div>
              {brandCard ? <div style={{ position: 'relative' }}>{brandCard}</div> : null}
            </div>
            <RailNav
              sections={sections}
              collapsed={false}
              label={labels.primaryNavigation}
              onNavigate={closeDrawer}
              scope="drawer"
            />
            <div className="bsp-sb-foot">{profile}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
