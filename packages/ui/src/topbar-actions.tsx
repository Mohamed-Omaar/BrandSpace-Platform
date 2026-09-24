'use client';

import Link from 'next/link';
import { colorTokens, layoutTokens, radiusTokens, spacingTokens, typographyTokens } from './tokens';
import { DropdownMenu } from './overlays';
import { CheckIcon, NoteIcon, SparkIcon } from './icons';
import { menuItemStyle } from './menu-style';

/**
 * THE TOP BAR'S LINKS AND CREATE MENU.
 *
 * P6-16 replaced the customer dashboard's preview action set with `TopbarLink`
 * and `TopbarCreateMenu`, each leading to a real screen with real counts. The
 * preview set itself (`TopbarActions`: a search box, a bell and a "+ Create"
 * that each opened a "not connected yet" panel) survived only in the Control
 * Center, and D-309 removed it there too: the Control Center has no search,
 * notification or create domain, so those controls promised capabilities that
 * do not exist. Nothing in the product renders a placeholder top-bar action.
 */

/* ------------------------------------------------------------------------ */
/* P6-16 — the customer top bar: real destinations, real counts.             */
/* ------------------------------------------------------------------------ */

/**
 * What an icon link is waiting to tell the reader. `count` comes from the
 * domain behind the destination; `label` is that count in words ("3 unread"),
 * already in the reader's language.
 */
export interface TopbarIndicator {
  readonly count: number;
  readonly label: string;
}

export type TopbarGlyph = 'review' | 'notes' | 'notifications' | 'copilot';

function Glyph({ glyph }: { readonly glyph: TopbarGlyph }) {
  // 16px, the size the demo's bell has always been drawn at, so the four sit
  // together. The bell keeps its own lighter mark; the others are the icons
  // the same destinations wear in the rail.
  if (glyph === 'notifications') return <BellGlyph />;
  if (glyph === 'review') return <CheckIcon size={16} />;
  if (glyph === 'notes') return <NoteIcon size={16} />;
  return <SparkIcon size={16} />;
}

/**
 * One of the top bar's round-cornered square actions — the demo's
 * `.icon-button` (38×38, soft fill, 12px radius) — as a LINK to a real screen.
 *
 * THE DOT MEANS SOMETHING NOW. `.notification-dot` was decoration drawn on
 * every page; here it is drawn only when the destination's own domain reports
 * a non-zero count, and the count is part of the link's accessible name, so a
 * screen reader hears what a sighted reader sees.
 */
export function TopbarLink({
  href,
  label,
  glyph,
  indicator,
  current = false,
  testId,
  showLabel = false,
}: {
  readonly href: string;
  readonly label: string;
  readonly glyph: TopbarGlyph;
  readonly indicator?: TopbarIndicator | null | undefined;
  /** The reader is already on this destination. */
  readonly current?: boolean;
  readonly testId: string;
  /**
   * THE LABEL ON SCREEN, not only in `aria-label` (Phase 6 final acceptance,
   * D-304). For the one control whose icon a new customer cannot be expected
   * to decode — the Copilot's spark. Same 38px height and radius as the
   * squares, the product's Copilot tint (lavender surface, pressed-purple
   * text) and the glyph kept beside the word.
   */
  readonly showLabel?: boolean;
}) {
  const active = indicator !== null && indicator !== undefined && indicator.count > 0;
  const name = active ? `${label}, ${indicator.label}` : label;
  return (
    <Link
      href={href}
      className="bs-control bs-pressable"
      aria-label={showLabel ? undefined : name}
      title={name}
      aria-current={current ? 'page' : undefined}
      data-testid={testId}
      data-indicator={active ? String(indicator.count) : undefined}
      style={{
        position: 'relative',
        display: showLabel ? 'inline-flex' : 'grid',
        placeItems: 'center',
        alignItems: 'center',
        gap: showLabel ? spacingTokens['3xs'] : undefined,
        inlineSize: showLabel ? 'auto' : layoutTokens.iconButton,
        paddingInline: showLabel ? '0.75rem' : undefined,
        blockSize: layoutTokens.iconButton,
        flexShrink: 0,
        borderRadius: radiusTokens.control,
        border: '1px solid transparent',
        background: showLabel ? colorTokens.surfaceLavenderStrong : undefined,
        color: showLabel ? colorTokens.brandPurplePressed : colorTokens.textPrimary,
        textDecoration: 'none',
        ...(showLabel ? typographyTokens.button : {}),
      }}
    >
      <span aria-hidden="true" style={{ display: 'inline-flex' }}>
        <Glyph glyph={glyph} />
      </span>
      {showLabel ? <span data-testid={`${testId}-label`}>{label}</span> : null}
      {active ? (
        /* `.notification-dot { right: 8px; top: 8px; width: 5px; height: 5px }`. */
        <span
          aria-hidden="true"
          data-testid={`${testId}-dot`}
          style={{
            position: 'absolute',
            insetInlineEnd: '8px',
            insetBlockStart: '8px',
            inlineSize: '5px',
            blockSize: '5px',
            borderRadius: '50%',
            background: colorTokens.brandPurple,
          }}
        />
      ) : null}
    </Link>
  );
}

export interface TopbarCreateItem {
  readonly key: string;
  readonly href: string;
  readonly label: string;
}

/**
 * The purple `+ Create`, opening a menu of the creation flows this member can
 * actually start. The application decides the list from the member's
 * permissions; with nothing to offer the button is not drawn at all, because a
 * create button that leads nowhere is the placeholder this replaces.
 */
export function TopbarCreateMenu({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly TopbarCreateItem[];
}) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu
      label={label}
      testId="topbar-create"
      trigger="primary"
      align="end"
      triggerContent={
        <>
          <span aria-hidden="true">+</span>
          {label}
        </>
      }
    >
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          role="menuitem"
          data-testid={`topbar-create-${item.key}`}
          style={menuItemStyle()}
        >
          {item.label}
        </Link>
      ))}
    </DropdownMenu>
  );
}

/** `♢` in the demo — a light diamond bell mark rather than a heavy glyph. */
function BellGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </svg>
  );
}
