'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * BATCH 7 (A3) — A FILE BEING CHECKED OR READ IS SHOWN MOVING. While `active`,
 * the page is re-read every few seconds (the same server render, no new
 * path), so "Checking…" turns into the logo, and "Reading" into the facts or
 * the reason, without the reader having to reload. It stops by itself after a
 * few minutes; a file still not done by then is the sweep's to finish.
 */
export function RefreshWhile({
  active,
  everyMs = 2_500,
  forMs = 3 * 60_000,
}: {
  readonly active: boolean;
  readonly everyMs?: number;
  readonly forMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > forMs) {
        window.clearInterval(timer);
        return;
      }
      router.refresh();
    }, everyMs);
    return () => window.clearInterval(timer);
  }, [active, everyMs, forMs, router]);
  return null;
}
