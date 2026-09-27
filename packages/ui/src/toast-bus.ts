import type { Tone } from './feedback';

/**
 * C8 (Phase 2B-2b) — HOW CLIENT CODE ASKS THE ONE `ToastHost` FOR A TOAST.
 *
 * A neutral module, not the host's `'use client'` file: that file may export
 * only components, hooks and types (`design-system.test.ts`). The host
 * listens for this event; nothing else renders a toast.
 */
export interface ToastMessage {
  readonly tone: Tone;
  readonly message: string;
  readonly action?:
    | {
        readonly label: string;
        readonly onAction: () => void;
        readonly testId?: string | undefined;
      }
    | undefined;
  readonly testId?: string | undefined;
}

export const TOAST_EVENT = 'brandspace:toast';

/** Shows `toast` in the page's host, replacing whatever it was showing. */
export function showToast(toast: ToastMessage): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ToastMessage>(TOAST_EVENT, { detail: toast }));
}
