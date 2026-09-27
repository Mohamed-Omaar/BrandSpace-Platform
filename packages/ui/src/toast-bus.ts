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

/**
 * MO10 (Phase 2B-2b, owner option A) — AN INCOMING MENTION, as the shell hands
 * it to the host: the sender's initial, the title ("Sam mentioned you"), one
 * line of context, and where Open goes. The server reads only unread mentions
 * by OTHER people (`NotesService.incomingMentions`).
 */
export interface IncomingNotice {
  readonly id: string;
  readonly initial: string;
  readonly title: string;
  readonly context: string | null;
  readonly href: string;
}

/** The session key holding the mentions this browser tab has already announced. */
export const INCOMING_SEEN_KEY = 'brandspace.incoming.seen';

/**
 * The notice to show now: the newest one this tab has not announced yet.
 * "Once per notification per browser tab" (owner answer 1) — `seen` is that
 * tab's memory; the list is already newest first.
 */
export function pickIncoming(
  incoming: readonly IncomingNotice[],
  seen: readonly string[],
): IncomingNotice | null {
  return incoming.find((notice) => !seen.includes(notice.id)) ?? null;
}
