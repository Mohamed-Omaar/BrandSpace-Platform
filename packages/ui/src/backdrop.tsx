'use client';

import type { ReactNode } from 'react';

/**
 * THE ONE BACKDROP (design-system programme, S5; D-5).
 *
 * Every drawer, sheet and modal dialog sits on this layer: the side sheets,
 * the post drawer, the Copilot drawer and phone sheet, the phone navigation
 * drawer, `Dialog`, and the rule-builder and campaign dialogs. There used to be
 * four tints, some blurred, on two z-index scales; now one tint (`--bs-scrim`),
 * one blur (`--bs-fx-backdrop-scrim`) and the token z-index (`layer`).
 *
 * `position: fixed; inset: 0` covers the WINDOW only while no ancestor makes
 * itself the containing block of fixed descendants (`transform`, `filter`,
 * `backdrop-filter`, `contain`, `will-change` of those). The app frame's
 * full-window blur did exactly that, so the backdrop covered only the frame and
 * a side sheet was as tall as the frame (KNOWN bugs 8 and 9). D-575 removed that
 * blur; `tests/e2e/backdrop.spec.ts` keeps every backdrop at the window's size.
 *
 * Pointer: a press on the backdrop itself (not on the panel inside it) calls
 * `onDismiss`. `leaving` keeps it on screen, inert and hidden from assistive
 * technology, while the panel's exit motion runs.
 */
export type BackdropLayer = 'drawer' | 'overlay' | 'dialog';

export function Backdrop({
  layer,
  onDismiss,
  leaving = false,
  fade = false,
  className,
  testId,
  children,
}: {
  /** The z-index token: `drawer` 40, `overlay` 50, `dialog` 60. */
  readonly layer: BackdropLayer;
  readonly onDismiss?: (() => void) | undefined;
  readonly leaving?: boolean | undefined;
  /** MO6: a modal's veil fades in (260 ms). Drawers do not. */
  readonly fade?: boolean | undefined;
  /** Layout of what sits on it (centring a dialog), never its look. */
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      data-backdrop={layer}
      className={['bs-backdrop', fade ? 'bs-veil' : '', className ?? ''].filter(Boolean).join(' ')}
      {...(leaving ? { 'data-leaving': '', 'aria-hidden': true, inert: true } : {})}
      onMouseDown={
        onDismiss
          ? (event) => {
              if (event.target === event.currentTarget) onDismiss();
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}
