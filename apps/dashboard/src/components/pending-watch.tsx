'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { translator } from '../i18n/messages';
import { useMessageLocale } from '../i18n/message-locale-context';
import { PENDING_STOP_AFTER_MS, startPendingPoll } from './pending-poll';

/**
 * B1 (performance) — A FILE STILL BEING CHECKED OR READ, FOLLOWED CHEAPLY.
 *
 * It replaces `RefreshWhile`, which re-rendered the WHOLE PAGE every 2.5 s
 * (hundreds of SQL statements, and every image re-fetched) and then every
 * 15 s with no end, even in a tab nobody was looking at. Now:
 *
 *   - it asks `/api/pending` about only the items still going — a small
 *     answer — and re-renders the page ONCE, when one of them has finished;
 *   - it backs off: 2.5 s, 2.5 s, 5 s, 5 s, 10 s, 10 s, then every 15 s;
 *   - while the tab is hidden no timer runs at all; back in view it asks
 *     at once and carries on;
 *   - after `stopAfterMs` (10 minutes) it stops and says so — "Still
 *     working — refresh to check", with a Refresh button — never silently.
 */

export function PendingWatch({
  locale,
  assets = [],
  sources = [],
  stopAfterMs = PENDING_STOP_AFTER_MS,
}: {
  readonly locale: string;
  readonly assets?: readonly string[];
  readonly sources?: readonly string[];
  readonly stopAfterMs?: number;
}) {
  const router = useRouter();
  const t = translator(useMessageLocale(locale));
  const [stopped, setStopped] = useState(false);
  const [round, setRound] = useState(0);
  const assetKey = [...assets].sort().join(',');
  const sourceKey = [...sources].sort().join(',');
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    if (assetKey === '' && sourceKey === '') return undefined;
    const query = new URLSearchParams();
    if (assetKey !== '') query.set('assets', assetKey);
    if (sourceKey !== '') query.set('sources', sourceKey);
    const url = `/api/pending?${query.toString()}`;
    setStopped(false);
    const poll = startPendingPoll(
      {
        ask: async () => {
          const response = await fetch(url, { cache: 'no-store' });
          if (!response.ok) return null;
          const body = (await response.json()) as { pending?: Record<string, boolean> };
          return body.pending ?? null;
        },
        now: () => Date.now(),
        setTimer: (run, ms) => window.setTimeout(run, ms),
        clearTimer: (timer) => window.clearTimeout(timer as number),
        hidden: () => document.visibilityState === 'hidden',
        onFinished: () => routerRef.current.refresh(),
        onStopped: () => setStopped(true),
      },
      stopAfterMs,
    );
    document.addEventListener('visibilitychange', poll.visibilityChanged);
    return () => {
      poll.stop();
      document.removeEventListener('visibilitychange', poll.visibilityChanged);
    };
    // `round` starts it again after Refresh.
  }, [assetKey, sourceKey, round, stopAfterMs]);

  if (!stopped) return null;
  return (
    <span className="bsp-st-hint" role="status" data-testid="pending-stopped">
      {t('pending.stillWorking')}{' '}
      <button
        type="button"
        className="bsp-btn bsp-sm"
        onClick={() => {
          router.refresh();
          setRound((value) => value + 1);
        }}
        data-testid="pending-refresh"
      >
        {t('pending.refresh')}
      </button>
    </span>
  );
}
