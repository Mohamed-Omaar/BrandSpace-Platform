'use client';

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
import { Button, buttonStyle } from './primitives';
import { ChevronDownIcon, CloseIcon } from './icons';

/**
 * Overlay behaviour: tooltip, dropdown menu, dialog, confirmation.
 *
 * THE HARD PART OF AN OVERLAY IS NOT THE BOX, IT IS THE KEYBOARD. Each of these
 * implements the same four obligations, and they are the reason these are
 * components rather than a div with a shadow:
 *
 *   1. Escape closes, from anywhere inside.
 *   2. Focus moves INTO the overlay when it opens.
 *   3. Focus is TRAPPED while it is open (a modal that lets Tab escape to the
 *      page behind it is a modal only for people using a mouse).
 *   4. Focus RETURNS to the trigger when it closes, so the keyboard user is not
 *      dumped at the top of the document.
 *
 * A click outside closes too, but that is a convenience — it is never the only
 * way out.
 */

/** Focusable descendants, in tab order. */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null || element === document.activeElement);
}

/**
 * Escape-to-close, focus trap, and focus restoration for an open overlay.
 *
 * One hook, used by the drawer, the dialog and the menu, so the three cannot
 * drift apart — which is exactly how one of them ends up without a trap.
 */
export function useOverlayBehaviour({
  open,
  onClose,
  containerRef,
  trap = true,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly containerRef: React.RefObject<HTMLElement | null>;
  readonly trap?: boolean;
}): void {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    restoreRef.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    // Move focus in. The container itself is focusable as a fallback, so an
    // overlay whose content is not yet interactive still receives focus.
    const first = container ? focusableWithin(container)[0] : null;
    (first ?? container)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (!trap || event.key !== 'Tab') return;
      const node = containerRef.current;
      if (!node) return;
      const focusable = focusableWithin(node);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const firstItem = focusable[0]!;
      const lastItem = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === firstItem || active === node)) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore focus to whatever opened this, so the keyboard user resumes
      // where they were rather than at the top of the document.
      restoreRef.current?.focus?.();
    };
  }, [open, onClose, containerRef, trap]);
}

/** Close when a pointer goes down outside `ref`. A convenience, never the only exit. */
export function useDismissOnOutsidePointer(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: MouseEvent) {
      const node = ref.current;
      if (node && !node.contains(event.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [ref, open, onClose]);
}

/**
 * Tooltip.
 *
 * Shown on hover AND on focus, because a control reachable only by keyboard
 * must still be explainable (WCAG 1.4.13). The tooltip is `role="tooltip"` and
 * wired with `aria-describedby`, so it SUPPLEMENTS the accessible name rather
 * than replacing it — an icon button still carries its own `aria-label`.
 */
export function Tooltip({
  label,
  placement = 'block-end',
  stretch = false,
  children,
}: {
  readonly label: string;
  readonly placement?: 'block-end' | 'inline-end';
  /**
   * Stretch to the trigger's container instead of shrink-wrapping it.
   *
   * The wrapper is `inline-flex`, so a child sized `inline-size: 100%` resolves
   * against the wrapper's own shrink-wrapped width — which is how the collapsed
   * rail's nav rows ended up 22px wide and sixteen pixels left of the rail's
   * centre line, while the workspace and profile cards beside them were
   * correctly centred.
   */
  readonly stretch?: boolean;
  readonly children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  const position: CSSProperties =
    placement === 'inline-end'
      ? {
          insetInlineStart: 'calc(100% + 8px)',
          insetBlockStart: '50%',
          transform: 'translateY(-50%)',
        }
      : {
          insetBlockStart: 'calc(100% + 8px)',
          insetInlineStart: '50%',
          transform: 'translateX(-50%)',
        };

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        ...(stretch ? { inlineSize: '100%' } : {}),
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      // Escape dismisses a tooltip without moving focus (WCAG 1.4.13).
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <span
        aria-describedby={open ? id : undefined}
        style={{ display: 'inline-flex', ...(stretch ? { inlineSize: '100%' } : {}) }}
      >
        {children}
      </span>
      <span
        role="tooltip"
        id={id}
        data-testid="tooltip"
        hidden={!open}
        style={{
          position: 'absolute',
          ...position,
          zIndex: zIndexTokens.tooltip,
          padding: `${spacingTokens.xs} ${spacingTokens.sm}`,
          borderRadius: radiusTokens.sm,
          background: colorTokens.surfaceInk,
          color: colorTokens.textInverse,
          ...typographyTokens.caption,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          boxShadow: shadowTokens.overlay,
        }}
      >
        {label}
      </span>
    </span>
  );
}

/**
 * Dropdown menu.
 *
 * `aria-haspopup="menu"` + `aria-expanded` on the trigger, `role="menu"` on the
 * list, arrow-key navigation between items, Escape to close and focus back to
 * the trigger. Items are buttons or links — never divs with click handlers,
 * which is how a menu ends up unusable without a mouse.
 */
export function DropdownMenu({
  label,
  triggerContent,
  children,
  align = 'end',
  testId,
  trigger = 'control',
  fullWidth = false,
  placement = 'block-end',
}: {
  readonly label: string;
  readonly triggerContent: ReactNode;
  readonly children: ReactNode;
  readonly align?: 'start' | 'end';
  readonly testId?: string | undefined;
  /**
   * How the trigger presents itself.
   *
   * `control` is the compact filled chip used in a toolbar. `card` is the
   * approved direction's SIDEBAR CARD: a full-width white surface with a large
   * radius and a very soft shadow, holding an avatar, two lines of text and a
   * chevron. The workspace switcher and the account button are cards; a
   * language menu in a top bar is a control.
   */
  readonly trigger?: 'control' | 'card';
  readonly fullWidth?: boolean;
  /** `block-start` opens upward — for a menu pinned to the foot of the rail. */
  readonly placement?: 'block-start' | 'block-end';
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  useDismissOnOutsidePointer(wrapperRef, open, close);
  useOverlayBehaviour({ open, onClose: close, containerRef: menuRef, trap: false });

  return (
    // `min-inline-size: 0` and `max-inline-size: 100%`: the trigger's content is
    // `white-space: nowrap`, so without these it takes its MAX-CONTENT width and
    // pushes the header off the screen — 10px of overhang at 390px, which the
    // responsive suite caught by name.
    <div ref={wrapperRef} style={{ position: 'relative', minInlineSize: 0, maxInlineSize: '100%' }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
        className={trigger === 'card' ? 'bs-pressable' : undefined}
        /*
         * A CARD TRIGGER IS NAMED EXPLICITLY, because its visible copy can be
         * hidden. In a collapsed 78px rail the reference shows only the avatar,
         * so the text that would otherwise name this button is `display: none`
         * — and a button whose only remaining child is an `aria-hidden` avatar
         * has no accessible name at all. The label carries it either way.
         */
        aria-label={trigger === 'card' ? label : undefined}
        style={
          trigger === 'card'
            ? {
                display: 'flex',
                alignItems: 'center',
                gap: spacingTokens.sm,
                inlineSize: '100%',
                minInlineSize: 0,
                overflow: 'hidden',
                // `.workspace-switcher { padding: 10px; radius: 15px;
                //  box-shadow: 0 4px 18px rgba(0,0,0,.035) }`, 54px tall.
                padding: layoutTokens.railCardPad,
                minBlockSize: '3.625rem',
                border: '1px solid transparent',
                borderRadius: radiusTokens.rail,
                background: colorTokens.surface,
                boxShadow: shadowTokens.rail,
                color: colorTokens.textPrimary,
                fontFamily: 'inherit',
                textAlign: 'start',
                cursor: 'pointer',
              }
            : {
                ...buttonStyle('neutral', 'sm'),
                gap: spacingTokens.xs,
                maxInlineSize: '100%',
                inlineSize: fullWidth ? '100%' : undefined,
                minInlineSize: 0,
                overflow: 'hidden',
              }
        }
      >
        {triggerContent}
        {trigger === 'card' && placement === 'block-start' ? (
          // `.more { color: var(--muted); font-size: 11px }` — the demo's
          // profile affordance is an ellipsis, not a chevron.
          <span aria-hidden="true" style={{ color: colorTokens.textMuted, fontSize: '0.6875rem' }}>
            {'\u2022\u2022\u2022'}
          </span>
        ) : (
          <ChevronDownIcon size={16} />
        )}
      </button>
      {open ? (
        <div
          id={id}
          ref={menuRef}
          role="menu"
          aria-label={label}
          data-testid={testId ? `${testId}-menu` : 'dropdown-menu'}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const items = menuRef.current ? focusableWithin(menuRef.current) : [];
            if (items.length === 0) return;
            const index = items.indexOf(document.activeElement as HTMLElement);
            const next =
              event.key === 'ArrowDown'
                ? items[(index + 1 + items.length) % items.length]
                : items[(index - 1 + items.length) % items.length];
            next?.focus();
          }}
          style={{
            position: 'absolute',
            insetBlockStart: placement === 'block-end' ? 'calc(100% + 6px)' : undefined,
            insetBlockEnd: placement === 'block-start' ? 'calc(100% + 6px)' : undefined,
            insetInlineEnd: align === 'end' ? 0 : undefined,
            insetInlineStart: align === 'start' ? 0 : undefined,
            zIndex: zIndexTokens.overlay,
            minInlineSize: '13rem',
            padding: spacingTokens.xs,
            background: colorTokens.surface,
            // A soft floating panel: shadow and radius, no outline (D-54).
            border: '1px solid transparent',
            borderRadius: radiusTokens.lg,
            boxShadow: shadowTokens.overlay,
            display: 'grid',
            gap: spacingTokens['3xs'],
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Modal dialog.
 *
 * `role="dialog" aria-modal="true"` with a labelled title, a scrim that is
 * inert to screen readers, a focus trap and focus restoration. `open` is the
 * caller's state: a dialog that owns its own visibility cannot be driven by a
 * URL or a server action result.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  closeLabel,
  footer,
  children,
  testId,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string | undefined;
  readonly closeLabel: string;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
  readonly testId?: string | undefined;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  useOverlayBehaviour({ open, onClose, containerRef: panelRef });

  if (!open) return null;

  return (
    <div
      data-testid={testId ? `${testId}-scrim` : 'dialog-scrim'}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: zIndexTokens.dialog,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacingTokens.md,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        data-testid={testId ?? 'dialog'}
        tabIndex={-1}
        style={{
          inlineSize: '100%',
          maxInlineSize: '30rem',
          maxBlockSize: '90vh',
          overflowY: 'auto',
          background: colorTokens.surface,
          borderRadius: radiusTokens['2xl'],
          boxShadow: shadowTokens.overlay,
          padding: spacingTokens.xl,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: spacingTokens.md,
            marginBlockEnd: spacingTokens.sm,
          }}
        >
          <h2 id={titleId} style={{ ...typographyTokens.h2, color: colorTokens.textPrimary }}>
            {title}
          </h2>
          <button
            type="button"
            aria-label={closeLabel}
            data-testid="dialog-close"
            onClick={onClose}
            className="bs-pressable bs-control"
            style={{
              ...buttonStyle('ghost', 'sm'),
              inlineSize: '2.25rem',
              blockSize: '2.25rem',
              paddingInline: 0,
              borderRadius: radiusTokens.full,
              color: colorTokens.textSecondary,
            }}
          >
            <CloseIcon size={18} />
          </button>
        </div>
        {description ? (
          <p
            id={descriptionId}
            style={{
              margin: 0,
              marginBlockEnd: spacingTokens.md,
              ...typographyTokens.bodySm,
              color: colorTokens.textSecondary,
            }}
          >
            {description}
          </p>
        ) : null}
        {children}
        {footer ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              gap: spacingTokens.sm,
              marginBlockStart: spacingTokens.lg,
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Confirmation for a high-impact action.
 *
 * CLAUDE.md §2.5: publishing, deleting, disconnecting, paying and sending are
 * high-impact and require an explicit confirmation policy. This is the visual
 * half of that policy — the service still authorises and audits independently,
 * because a dialog is a courtesy to the operator, never a control.
 *
 * The confirming button is `danger` and is NOT the default focus: focus lands
 * on Cancel, so an Enter keypress carried over from the previous screen cannot
 * confirm a destructive action.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  closeLabel,
  testId,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly closeLabel: string;
  readonly testId?: string | undefined;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      closeLabel={closeLabel}
      testId={testId ?? 'confirm-dialog'}
      footer={
        <>
          <Button variant="neutral" onClick={onClose} data-testid="confirm-cancel">
            {cancelLabel}
          </Button>
          <Button variant="danger" onClick={onConfirm} data-testid="confirm-accept">
            {confirmLabel}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

/**
 * Tabs.
 *
 * The WAI-ARIA tab pattern: one tab stop for the whole list, arrow keys to move
 * between tabs, Home/End to jump. Activation follows selection, which is
 * correct here because every panel is already rendered.
 */
export function Tabs({
  label,
  tabs,
  activeId,
  onSelect,
  testId,
}: {
  readonly label: string;
  readonly tabs: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly badge?: string | undefined;
  }>;
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
  readonly testId?: string | undefined;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      data-testid={testId ?? 'tabs'}
      onKeyDown={(event) => {
        const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const index = tabs.findIndex((tab) => tab.id === activeId);
        // The inline axis is direction-aware: in RTL, ArrowRight moves toward
        // the START of the list, which is what a reader of Arabic expects.
        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
        const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
        let next = index;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else if (event.key === forward) next = (index + 1) % tabs.length;
        else next = (index - 1 + tabs.length) % tabs.length;
        const target = tabs[next];
        if (target) {
          onSelect(target.id);
          listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${target.id}"]`)?.focus();
        }
      }}
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        gap: spacingTokens['3xs'],
        // A soft segmented control rather than a ruled strip of underlines.
        padding: spacingTokens['3xs'],
        borderRadius: radiusTokens.lg,
        background: colorTokens.surfaceMuted,
        marginBlockEnd: spacingTokens.lg,
        maxInlineSize: '100%',
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            data-tab-id={tab.id}
            data-testid={`tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className="bs-pressable"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: spacingTokens.xs,
              minBlockSize: '2.25rem',
              paddingInline: spacingTokens.md,
              border: 0,
              borderRadius: radiusTokens.md,
              cursor: 'pointer',
              fontFamily: 'inherit',
              ...typographyTokens.bodySm,
              fontWeight: 600,
              // The selected tab is a raised white pill on the muted track AND
              // carries `aria-selected`, so the state is never colour alone.
              background: selected ? colorTokens.surface : 'transparent',
              color: selected ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
              boxShadow: selected ? shadowTokens.card : 'none',
              transition: `color ${motionTokens.fast} ${motionTokens.easeOut}`,
            }}
          >
            {tab.label}
            {tab.badge ? (
              <span
                style={{
                  paddingInline: spacingTokens.xs,
                  borderRadius: radiusTokens.full,
                  background: selected
                    ? colorTokens.surfaceLavenderStrong
                    : colorTokens.surfaceSunken,
                  color: selected ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
                  ...typographyTokens.caption,
                }}
              >
                {tab.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  id,
  activeId,
  children,
}: {
  readonly id: string;
  readonly activeId: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      data-testid={`panel-${id}`}
      hidden={id !== activeId}
      tabIndex={0}
    >
      {id === activeId ? children : null}
    </div>
  );
}
