'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  colorTokens,
  layoutTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
  zIndexTokens,
} from './tokens';
import { useOverlayBehaviour } from './overlays';

/**
 * THE TOP BAR'S ACTION SET, as the full demo composes it (§9, §10).
 *
 * `.search-button` (230×38, soft fill, a ⌘K chip), an `.icon-button` for
 * notifications with a 5px purple dot, the 38px `.language-button`, and the
 * purple `.primary-button` that starts something new. Together they are most of
 * the top bar's visual weight, and the product had none of them — which is why
 * its right-hand side read as empty next to the demo's.
 *
 * NOTHING HERE IS A DEAD CONTROL, and nothing here fakes a capability. Search
 * and notifications open a panel that says, in the reader's own language, what
 * the control will do and that it is not connected yet. §10 asks for exactly
 * that: keep the composition, do not grey it out, do not pretend it works.
 */

export interface TopbarLabels {
  readonly search: string;
  readonly searchShortcut: string;
  readonly notifications: string;
  readonly close: string;
  /** The honest explanation shown when an unconnected action is activated. */
  readonly previewTitle: string;
  readonly previewBody: string;
  /** The purple entry point's label. `+ Create` in the demo. */
  readonly create: string;
}

function Sheet({
  labels,
  title,
  body,
  onClose,
  testId,
}: {
  readonly labels: TopbarLabels;
  readonly title: string;
  readonly body: string;
  readonly onClose: () => void;
  readonly testId: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useOverlayBehaviour({ open: true, onClose, containerRef: panelRef });

  return (
    <div
      data-testid={`${testId}-scrim`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: zIndexTokens.overlay,
        /* `.command-backdrop { background: rgba(10,10,12,.28); padding-top: 12vh }`. */
        background: 'rgba(10, 10, 12, 0.28)',
        display: 'grid',
        placeItems: 'start center',
        paddingBlockStart: '12vh',
        paddingInline: spacingTokens.md,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        tabIndex={-1}
        style={{
          /*
            `.command-dialog { width: min(570px, calc(100% - 30px)); padding: 8px;
             background: #fff; border-radius: 20px;
             box-shadow: 0 35px 90px rgba(0,0,0,.24) }` — an opaque sheet with
            8px of padding, not a translucent card with 22px.
          */
          inlineSize: '100%',
          maxInlineSize: layoutTokens.commandDialogWidth,
          padding: spacingTokens.xs,
          borderRadius: radiusTokens.card,
          background: colorTokens.surface,
          boxShadow: shadowTokens.commandDialog,
          display: 'grid',
          gap: spacingTokens['3xs'],
        }}
      >
        {/* `.command-dialog label { padding: 12px }` — the sheet's 8px is the
            frame; its rows carry their own padding. */}
        <div style={{ display: 'grid', gap: spacingTokens['3xs'], padding: spacingTokens.sm }}>
          <p
            style={{
              margin: 0,
              ...typographyTokens.overline,
              textTransform: 'uppercase',
              color: colorTokens.textMuted,
            }}
          >
            {labels.previewTitle}
          </p>
          <p style={{ margin: 0, ...typographyTokens.h3, color: colorTokens.textPrimary }}>
            {title}
          </p>
          <p style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
            {body}
          </p>
        </div>
        <button
          type="button"
          className="bs-control bs-pressable"
          data-testid={`${testId}-close`}
          onClick={onClose}
          style={{
            justifySelf: 'end',
            minBlockSize: layoutTokens.controlHeightSm,
            paddingInline: '0.9375rem',
            borderRadius: radiusTokens.control,
            border: '1px solid transparent',
            fontFamily: 'inherit',
            ...typographyTokens.button,
            color: colorTokens.textPrimary,
            cursor: 'pointer',
          }}
        >
          {labels.close}
        </button>
      </div>
    </div>
  );
}

export function TopbarActions({
  labels,
  create,
  language,
}: {
  readonly labels: TopbarLabels;
  /** The purple entry point. Supplied by the app so it leads somewhere real. */
  readonly create?: ReactNode;
  readonly language?: ReactNode;
}) {
  const [open, setOpen] = useState<'search' | 'notifications' | 'create' | null>(null);

  // ⌘K / Ctrl+K, as the demo's `kbd` chip advertises.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen('search');
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const iconButton = {
    position: 'relative' as const,
    display: 'grid',
    placeItems: 'center',
    inlineSize: layoutTokens.iconButton,
    blockSize: layoutTokens.iconButton,
    flexShrink: 0,
    borderRadius: radiusTokens.control,
    border: '1px solid transparent',
    color: colorTokens.textPrimary,
    fontFamily: 'inherit',
    cursor: 'pointer',
  };

  return (
    <>
      {/* `.search-button { width: 230px; height: 38px; border-radius: 12px;
          background: var(--soft); padding: 0 10px; gap: 8px; font-size: 10px }` */}
      <button
        type="button"
        className="bs-control bs-pressable bs-search-button"
        data-testid="topbar-search"
        onClick={() => setOpen('search')}
        style={{
          alignItems: 'center',
          gap: spacingTokens.sm,
          inlineSize: layoutTokens.searchWidth,
          blockSize: layoutTokens.iconButton,
          paddingInline: '0.625rem',
          borderRadius: radiusTokens.control,
          border: '1px solid transparent',
          color: colorTokens.textMuted,
          fontFamily: 'inherit',
          fontSize: typographyTokens.button.fontSize,
          textAlign: 'start',
          cursor: 'pointer',
        }}
      >
        <span aria-hidden="true" style={{ display: 'inline-flex' }}>
          <SearchGlyph />
        </span>
        <span style={{ flex: 1 }}>{labels.search}</span>
        <kbd
          style={{
            padding: '3px 5px',
            borderRadius: radiusTokens.xs,
            background: colorTokens.surface,
            // `.search-button kbd { color: #999 }` is 2.85:1; darkened to 4.54.
            color: '#767676',
            /*
              INHERIT the page's stack. A monospace override put U+2318 (⌘)
              through a fallback face that does not carry it, and the chip
              rendered "» K". The demo's kbd inherits, and the glyph is there.
            */
            fontFamily: 'inherit',
            fontSize: '0.5rem',
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {labels.searchShortcut}
        </kbd>
      </button>

      <button
        type="button"
        className="bs-control bs-pressable"
        aria-label={labels.notifications}
        data-testid="topbar-notifications"
        onClick={() => setOpen('notifications')}
        style={iconButton}
      >
        <span aria-hidden="true" style={{ display: 'inline-flex' }}>
          <BellGlyph />
        </span>
        {/* `.notification-dot { right: 8px; top: 8px; width: 5px; height: 5px }`.
            Decoration: the sheet it opens says what it means. */}
        <span
          aria-hidden="true"
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
      </button>

      {language}

      {/*
       * `.primary-button.compact` — the demo's purple entry point. Supplied by
       * the application when it has a real destination; otherwise it opens the
       * same honest panel the other unconnected actions do, because §10 wants
       * the composition kept without the functionality being faked.
       */}
      {create ?? (
        <button
          type="button"
          className="bs-pressable bs-filled-brand"
          data-testid="topbar-create"
          onClick={() => setOpen('create')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: spacingTokens['3xs'],
            minBlockSize: layoutTokens.iconButton,
            paddingInline: '0.9375rem',
            flexShrink: 0,
            border: 0,
            borderRadius: radiusTokens.control,
            background: colorTokens.brandPurple,
            color: colorTokens.brandPurpleInk,
            fontFamily: 'inherit',
            ...typographyTokens.button,
            cursor: 'pointer',
          }}
        >
          <span aria-hidden="true">+</span>
          {labels.create}
        </button>
      )}

      {open === 'search' ? (
        <Sheet
          labels={labels}
          title={labels.search}
          body={labels.previewBody}
          testId="topbar-search-panel"
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open === 'create' ? (
        <Sheet
          labels={labels}
          title={labels.create}
          body={labels.previewBody}
          testId="topbar-create-panel"
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open === 'notifications' ? (
        <Sheet
          labels={labels}
          title={labels.notifications}
          body={labels.previewBody}
          testId="topbar-notifications-panel"
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

/** `⌕` in the demo. Drawn, so it inherits colour and scales with the control. */
function SearchGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </svg>
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
