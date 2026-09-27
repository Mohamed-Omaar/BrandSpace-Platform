'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Toast, type Tone } from './feedback';
import { spacingTokens, zIndexTokens } from './tokens';
import { TOAST_EVENT, type ToastMessage } from './toast-bus';
import { TOAST_RESUME_MS, toastDuration } from './toast-timing';

/**
 * C8 (Phase 2B-2b) — THE ONE TOAST HOST.
 *
 * A success that used to arrive as a `?ok=` banner at the top of the page now
 * arrives here. The SERVER still decides the words — the page resolves its
 * `ok` code to a translated message and hands it to the shell as `flash`, so
 * the toast is in the first HTML — and this client boundary owns only what a
 * server cannot: the reading-time timer (`toast-timing.ts`), holding it while
 * the pointer or focus is on it, dismissal, and closing on the next
 * navigation.
 *
 * THE URL IS CLEANED. Once shown, `?ok=` is taken off the address with
 * `history.replaceState`, which Next.js folds into its router, so a refresh
 * does not show the toast again and a copied link does not carry it.
 *
 * Client code raises a toast with `showToast` — the calendar's "Moved … Undo"
 * (§8.2) — through the same host. There is no second toast system.
 */
/** Where the reader is, in one comparable string. */
function locationKey(pathname: string, search: string): string {
  return `${pathname}?${new URLSearchParams(search).toString()}`;
}

export function ToastHost({
  flash,
  consume = 'ok',
  dismissLabel,
}: {
  /** The server-resolved words for this request's `?ok=`, when there is one. */
  readonly flash?: { readonly tone: Tone; readonly message: string } | undefined;
  /** The query parameter a flash arrives on, removed once shown. */
  readonly consume?: string | undefined;
  readonly dismissLabel: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const search = params.toString();
  const here = locationKey(pathname, search);

  const [current, setCurrent] = useState<(ToastMessage & { readonly key: number }) | null>(
    flash ? { ...flash, key: 0 } : null,
  );
  const currentRef = useRef(current);
  currentRef.current = current;
  const shownAt = useRef<string | null>(null);
  const sequence = useRef(1);
  const timer = useRef<number | undefined>(undefined);

  const close = useCallback(() => setCurrent(null), []);

  // THE NEXT NAVIGATION CLOSES IT. Declared before the flash below, so a
  // navigation that brings its own flash replaces the old toast with the new
  // one rather than closing both.
  useEffect(() => {
    if (currentRef.current && shownAt.current !== null && shownAt.current !== here) {
      setCurrent(null);
    }
  }, [here]);

  // THE FLASH: shown (again, now with its timer) and taken off the URL. Only
  // when the page handed one over: a page that still draws its own `?ok=`
  // banner keeps its URL exactly as it was.
  useEffect(() => {
    if (!flash || !params.has(consume)) return;
    const rest = new URLSearchParams(search);
    rest.delete(consume);
    const remaining = rest.toString();
    shownAt.current = locationKey(pathname, remaining);
    setCurrent({ ...flash, key: sequence.current++ });
    window.history.replaceState(
      null,
      '',
      `${pathname}${remaining ? `?${remaining}` : ''}${window.location.hash}`,
    );
  }, [consume, flash, params, pathname, search]);

  // A TOAST RAISED ON THE CLIENT.
  useEffect(() => {
    function onToast(event: Event) {
      const detail = (event as CustomEvent<ToastMessage>).detail;
      shownAt.current = locationKey(window.location.pathname, window.location.search);
      setCurrent({ ...detail, key: sequence.current++ });
    }
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  // THE READING TIME (MO9), restarted for every new toast.
  useEffect(() => {
    if (!current) return undefined;
    timer.current = window.setTimeout(close, toastDuration(current.message));
    return () => window.clearTimeout(timer.current);
  }, [current, close]);

  const hold = useCallback(() => window.clearTimeout(timer.current), []);
  const resume = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(close, TOAST_RESUME_MS);
  }, [close]);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toast-host"
      style={{
        position: 'fixed',
        insetInline: 0,
        insetBlockEnd: spacingTokens.lg,
        zIndex: zIndexTokens.toast,
        display: 'flex',
        justifyContent: 'center',
        paddingInline: spacingTokens.md,
        // The strip is click-through; only the toast itself takes the pointer.
        pointerEvents: 'none',
      }}
    >
      {current ? (
        <div
          key={current.key}
          data-toast-duration={toastDuration(current.message)}
          onMouseEnter={hold}
          onMouseLeave={resume}
          onFocus={hold}
          onBlur={resume}
          style={{ pointerEvents: 'auto', maxInlineSize: '100%' }}
        >
          <Toast
            tone={current.tone}
            announce={false}
            onDismiss={close}
            dismissLabel={dismissLabel}
            action={
              current.action
                ? {
                    ...current.action,
                    onAction: () => {
                      close();
                      current.action?.onAction();
                    },
                  }
                : undefined
            }
            testId={current.testId ?? 'toast'}
          >
            {current.message}
          </Toast>
        </div>
      ) : null}
    </div>
  );
}
