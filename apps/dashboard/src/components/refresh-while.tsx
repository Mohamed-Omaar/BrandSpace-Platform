'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * BATCH 7 (A3) — A FILE BEING CHECKED OR READ IS SHOWN MOVING. While `active`,
 * the page is re-read every few seconds (the same server render, no new
 * path), so "Checking…" turns into the logo, and "Reading" into the facts or
 * the reason, without the reader having to reload.
 *
 * PR F (g) — IT NEVER STOPS WHILE THE FILE IS STILL GOING. It used to stop
 * silently after three minutes, so a file that took longer looked frozen
 * until the reader reloaded. Now, after `forMs`, it only slows down — to
 * `slowEveryMs` — and keeps going until the file is done (`active` turns
 * false) or the reader leaves. It skips a beat while the tab is hidden, so a
 * forgotten tab does not keep re-reading the page.
 */
export function RefreshWhile({
  active,
  everyMs = 2_500,
  forMs = 3 * 60_000,
  slowEveryMs = 15_000,
}: {
  readonly active: boolean;
  readonly everyMs?: number;
  readonly forMs?: number;
  readonly slowEveryMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    let timer = 0;
    const tick = () => {
      if (document.visibilityState !== 'hidden') router.refresh();
      timer = window.setTimeout(tick, Date.now() - started > forMs ? slowEveryMs : everyMs);
    };
    timer = window.setTimeout(tick, everyMs);
    return () => window.clearTimeout(timer);
  }, [active, everyMs, forMs, slowEveryMs, router]);
  return null;
}
