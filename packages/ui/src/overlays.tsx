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
import { Button, buttonClass } from './primitives';
import { ChevronDownIcon, CloseIcon } from './icons';
import { OverlayStack, type StackedOverlay } from './overlay-stack';
import { usePresence } from './motion-hooks';

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
 * C8 (Phase 2B-2b) — THE ONE RECORD OF WHAT IS OPEN. Every managed overlay
 * registers here through `useOverlayBehaviour`; see `overlay-stack.ts` for the
 * rule. Module state, because there is one document: a provider would let two
 * trees keep two stacks, which is the bug this replaces.
 */
interface ManagedOverlay extends StackedOverlay {
  readonly trap: boolean;
  readonly container: () => HTMLElement | null;
}

const overlayStack = new OverlayStack<ManagedOverlay>();
let nextOverlayId = 1;

/*
 * WHERE AN OVERLAY WAS OPENED FROM. Focus, when the opener holds it (a keyboard
 * user, or a click in a browser that focuses buttons); otherwise the last
 * element a pointer went down on — Safari and Firefox on macOS do not focus a
 * clicked button, and without this a dialog asked from a sheet would read as
 * "opened from outside" and close the sheet.
 */
let lastPointerTarget: EventTarget | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (event) => {
      lastPointerTarget = event.target;
    },
    true,
  );
}

function openedFrom(): unknown {
  const active = document.activeElement;
  return active && active !== document.body ? active : lastPointerTarget;
}

/*
 * ONE keydown listener for every overlay, so exactly one of them hears Escape:
 * the top one. Only the top one traps Tab, too — a sheet underneath a dialog
 * must not pull focus back into itself.
 */
function onOverlayKeyDown(event: KeyboardEvent): void {
  const top = overlayStack.top();
  if (!top) return;
  if (event.key === 'Escape') {
    event.stopPropagation();
    top.close();
    return;
  }
  if (!top.trap || event.key !== 'Tab') return;
  const node = top.container();
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

function syncKeyListener(): void {
  document.removeEventListener('keydown', onOverlayKeyDown, true);
  if (overlayStack.entries.length > 0) document.addEventListener('keydown', onOverlayKeyDown, true);
}

/**
 * Escape-to-close, focus trap, and focus restoration for an open overlay —
 * and, since C8, its place in the shared overlay stack.
 *
 * One hook, used by the drawer, the dialog and the menu, so the three cannot
 * drift apart — which is exactly how one of them ends up without a trap.
 */
export function useOverlayBehaviour({
  open,
  onClose,
  containerRef,
  trap = true,
  initialFocusRef,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly containerRef: React.RefObject<HTMLElement | null>;
  readonly trap?: boolean;
  /** Where focus goes on open, when not the first focusable element (a close button). */
  readonly initialFocusRef?: React.RefObject<HTMLElement | null> | undefined;
}): React.RefObject<number | null> {
  // This overlay's place in the stack while it is open, for the caller.
  const entryId = useRef<number | null>(null);
  // The latest `onClose`, without re-registering: a caller passing an inline
  // arrow must not close and reopen the overlay on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;

    const restoreTo = document.activeElement as HTMLElement | null;
    const origin = openedFrom();
    const container = containerRef.current;
    const entry: ManagedOverlay = {
      id: nextOverlayId++,
      trap,
      container: () => containerRef.current,
      contains: (node) => {
        const surface = containerRef.current ?? container;
        return surface !== null && node instanceof Node && surface.contains(node);
      },
      close: () => onCloseRef.current(),
    };
    const displaced = overlayStack.open(entry, origin);
    entryId.current = entry.id;
    syncKeyListener();

    // Move focus in. The container itself is focusable as a fallback, so an
    // overlay whose content is not yet interactive still receives focus.
    const first = initialFocusRef?.current ?? (container ? focusableWithin(container)[0] : null);
    (first ?? container)?.focus();

    // Opened from outside: whatever was open closes (after focus moved here,
    // so their focus restoration below leaves it here).
    for (const other of displaced) other.close();

    return () => {
      entryId.current = null;
      const above = overlayStack.close(entry.id);
      syncKeyListener();
      for (const other of above) other.close();
      // Restore focus to whatever opened this, so the keyboard user resumes
      // where they were rather than at the top of the document — unless focus
      // already lives in another open overlay (the one that displaced this).
      const active = document.activeElement;
      if (!(active && overlayStack.anyContains(active))) restoreTo?.focus?.();
    };
  }, [open, containerRef, trap, initialFocusRef]);

  return entryId;
}

/**
 * Close when a pointer goes down outside `ref`. A convenience, never the only
 * exit. With `overlayId` (the stack entry of the surface `ref` belongs to), a
 * pointer inside an overlay stacked ABOVE it does not count as outside: that
 * overlay was opened from this one, and closing this one would close it too.
 */
export function useDismissOnOutsidePointer(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  overlayId?: React.RefObject<number | null>,
): void {
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: MouseEvent) {
      const node = ref.current;
      const id = overlayId?.current ?? null;
      if (id !== null && overlayStack.isAbove(id, event.target)) return;
      if (node && !node.contains(event.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [ref, open, onClose, overlayId]);
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
   *
   * Round 4, 2.2: stretched, the trigger is also CENTRED in it. A collapsed
   * rail row is the prototype's 42px square (`.sb.min .nav`) inside the
   * 76px rail, and `.sb.min nav { align-items: center }` centres it; a full
   * width wrapper otherwise holds it at the start edge, 17px off the rail's
   * centre line. A trigger that fills the wrapper is unaffected.
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
        ...(stretch ? { inlineSize: '100%', justifyContent: 'center' } : {}),
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
        style={{
          display: 'inline-flex',
          ...(stretch ? { inlineSize: '100%', justifyContent: 'center' } : {}),
        }}
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
  triggerClassName,
  affordance,
  menuClassName,
  menuStyle,
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
   *
   * `primary` is the top bar's purple `.primary-button.compact` — `+ Create`
   * (P6-16). It keeps the demo's exact button and adds no chevron: the demo
   * draws none, and `aria-haspopup` already tells assistive technology that
   * it opens a menu.
   */
  readonly trigger?: 'control' | 'card' | 'primary';
  readonly fullWidth?: boolean;
  /** `block-start` opens upward — for a menu pinned to the foot of the rail. */
  readonly placement?: 'block-start' | 'block-end';
  /**
   * D-468 — A TRIGGER DRAWN BY A PORTED STYLESHEET. With a class, the trigger
   * takes its look from that class alone (`prototype.css`) and none of the
   * presets above; the menu-button behaviour is unchanged.
   */
  readonly triggerClassName?: string | undefined;
  /** Replaces the preset chevron or ellipsis; `null` draws none. */
  readonly affordance?: ReactNode;
  /** D-468 — the panel's class and placement, for a ported menu surface. */
  readonly menuClassName?: string | undefined;
  readonly menuStyle?: CSSProperties | undefined;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  /*
   * THE MENU-BUTTON KEYS (WAI-ARIA APG). ArrowDown / ArrowUp on the trigger
   * open the menu and move focus to its first / last item. Without this, arrow
   * keys only worked once focus was already inside the menu — and nothing put
   * it there — so a keyboard user had to Tab past the trigger to find the
   * items. Found by the P6-16 top-bar suite on the Create menu.
   */
  const [focusOnOpen, setFocusOnOpen] = useState<'first' | 'last' | null>(null);
  const menuEntry = useOverlayBehaviour({
    open,
    onClose: close,
    containerRef: menuRef,
    trap: false,
  });
  useDismissOnOutsidePointer(wrapperRef, open, close, menuEntry);
  // MO5: the menu leaves (180 ms) after it has closed.
  const { present, leaving } = usePresence(open, menuRef);
  // AFTER `useOverlayBehaviour`, deliberately: that hook records where focus
  // came from (the trigger) so Escape can return it there, and it must record
  // it before this moves focus into the menu.
  useEffect(() => {
    if (!open || focusOnOpen === null || !menuRef.current) return;
    const items = focusableWithin(menuRef.current);
    (focusOnOpen === 'first' ? items[0] : items[items.length - 1])?.focus();
    setFocusOnOpen(null);
  }, [open, focusOnOpen]);

  return (
    // `min-inline-size: 0` and `max-inline-size: 100%`: the trigger's content is
    // `white-space: nowrap`, so without these it takes its MAX-CONTENT width and
    // pushes the header off the screen — 10px of overhang at 390px, which the
    // responsive suite caught by name.
    <div
      ref={wrapperRef}
      style={{
        position: 'relative',
        minInlineSize: 0,
        maxInlineSize: '100%',
        // The top bar's create button never shrinks, as `.compact` does not.
        flexShrink: trigger === 'primary' ? 0 : undefined,
      }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setFocusOnOpen(event.key === 'ArrowDown' ? 'first' : 'last');
          setOpen(true);
        }}
        className={
          triggerClassName ??
          (trigger === 'card'
            ? 'bs-pressable'
            : trigger === 'primary'
              ? 'bs-pressable bs-filled-brand'
              : buttonClass('neutral', 'sm'))
        }
        /*
         * A CARD TRIGGER IS NAMED EXPLICITLY, because its visible copy can be
         * hidden. In a collapsed 78px rail the reference shows only the avatar,
         * so the text that would otherwise name this button is `display: none`
         * — and a button whose only remaining child is an `aria-hidden` avatar
         * has no accessible name at all. The label carries it either way.
         */
        aria-label={trigger === 'card' ? label : undefined}
        style={
          triggerClassName
            ? undefined
            : trigger === 'primary'
              ? {
                  /* `.primary-button.compact { min-height: 38px; padding: 0 15px;
                   border-radius: 12px; background: var(--purple); color: #fff }`
                   — byte for byte the create button the top bar always drew. */
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
                }
              : trigger === 'card'
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
                    gap: spacingTokens.xs,
                    maxInlineSize: '100%',
                    inlineSize: fullWidth ? '100%' : undefined,
                    minInlineSize: 0,
                    overflow: 'hidden',
                  }
        }
      >
        {triggerContent}
        {affordance !== undefined ? (
          affordance
        ) : trigger === 'primary' ? null : trigger === 'card' && placement === 'block-start' ? (
          // `.more { color: var(--muted); font-size: 11px }` — the demo's
          // profile affordance is an ellipsis, not a chevron.
          <span
            aria-hidden="true"
            className="bs-dropdown-affordance"
            style={{ color: colorTokens.textMuted, fontSize: '0.6875rem', flexShrink: 0 }}
          >
            {'\u2022\u2022\u2022'}
          </span>
        ) : (
          <ChevronDownIcon size={16} />
        )}
      </button>
      {present ? (
        <div
          id={id}
          ref={menuRef}
          role="menu"
          aria-label={label}
          data-testid={testId ? `${testId}-menu` : 'dropdown-menu'}
          // Following a link in the menu closes it: a client-side navigation
          // can keep this component mounted, and a menu left open over the
          // page it led to reads as if the choice did not take.
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a[href]')) close();
          }}
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
          className={
            menuClassName ??
            `bs-dropdown-menu bs-dropdown-panel bs-pop${placement === 'block-start' ? ' bs-pop-up' : ''}`
          }
          data-origin={align}
          {...(leaving ? { 'data-leaving': '', 'aria-hidden': true, inert: true } : {})}
          style={
            menuClassName
              ? { position: 'absolute', zIndex: zIndexTokens.overlay, ...menuStyle }
              : {
                  position: 'absolute',
                  insetBlockStart: placement === 'block-end' ? 'calc(100% + 6px)' : undefined,
                  insetBlockEnd: placement === 'block-start' ? 'calc(100% + 6px)' : undefined,
                  insetInlineEnd: align === 'end' ? 0 : undefined,
                  insetInlineStart: align === 'start' ? 0 : undefined,
                  zIndex: zIndexTokens.overlay,
                  minInlineSize: '13rem',
                  maxBlockSize: '18rem',
                  display: 'grid',
                  gap: spacingTokens['3xs'],
                }
          }
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
      // MO6: the veil fades in while its backdrop blur goes 0 → 3 px.
      className="bs-veil"
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
        // MO6: the dialog fades, grows from .98 and rises 8 px.
        className="bs-dialog-in"
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
            className={buttonClass('ghost', 'sm')}
            style={{ color: colorTokens.textSecondary }}
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

/**
 * PHASE 6 FINAL (D-285) — A SIDE SHEET: the global Copilot drawer's geometry,
 * for any in-context task that must not navigate away (the composer's media
 * drawer is the first). The same tokens, blur, radius and shadow as
 * `CopilotDrawer`; the same focus trap, Escape and focus restoration as
 * `Dialog`. A composition, not a new visual treatment.
 */
export function SideSheet({
  open,
  onClose,
  title,
  description,
  closeLabel,
  children,
  testId = 'side-sheet',
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string | undefined;
  readonly closeLabel: string;
  readonly children?: ReactNode;
  readonly testId?: string | undefined;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  useOverlayBehaviour({ open, onClose, containerRef: panelRef });
  // MO5: the sheet leaves (180 ms) after it has closed.
  const { present, leaving } = usePresence(open, panelRef);
  if (!present) return null;
  return (
    <div
      data-testid={`${testId}-scrim`}
      {...(leaving ? { 'data-leaving': '', 'aria-hidden': true, inert: true } : {})}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: zIndexTokens.drawer,
        background: 'rgba(12, 12, 14, 0.25)',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        tabIndex={-1}
        // MO5: opens from its trigger's side (the top bar's end), rows in order.
        className="bs-pop"
        data-origin="end"
        style={{
          position: 'fixed',
          insetBlock: layoutTokens.shellInset,
          insetInlineEnd: layoutTokens.shellInset,
          inlineSize: `min(${layoutTokens.drawerWidth}, calc(100vw - ${layoutTokens.shellInset} * 2))`,
          zIndex: zIndexTokens.overlay,
          overflowY: 'auto',
          background: colorTokens.drawerAlpha,
          backdropFilter: 'blur(24px)',
          borderRadius: radiusTokens['3xl'],
          boxShadow: shadowTokens.drawer,
          padding: spacingTokens.lg,
          display: 'grid',
          gap: spacingTokens.md,
          alignContent: 'start',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: spacingTokens.md,
          }}
        >
          <div style={{ display: 'grid', gap: spacingTokens['3xs'] }}>
            <h2
              id={titleId}
              style={{ margin: 0, ...typographyTokens.h3, color: colorTokens.textPrimary }}
            >
              {title}
            </h2>
            {description ? (
              <p
                style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
              >
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            data-testid={`${testId}-close`}
            onClick={onClose}
            className={buttonClass('ghost', 'sm')}
            style={{ color: colorTokens.textSecondary }}
          >
            <CloseIcon size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
