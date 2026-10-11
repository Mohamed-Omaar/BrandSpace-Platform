'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * PR D (Home 5) — THE NOTICED CARD STAYS, WITH ITS RESULT.
 *
 * The prototype keeps a decided card in place, greyed green, with a pill
 * saying what happened (`g.closed` / `g.result`, Main line 277): "Applied to
 * your next drafts", "We will remind you in 30 days", "We won't suggest this
 * again". The decision is a form post that redirects, and the decided item is
 * no longer one the server lists — so the press writes what the card showed
 * (its own words, already on this screen) to this tab's session storage, and
 * the page it lands on draws the card once more, closed. Nothing new is read
 * or shown, and only the redirect of that decision draws it.
 */
const KEY = 'bs.noticed.decided';

export interface NoticedSnapshot {
  readonly id: string;
  readonly glyph: string;
  readonly tag: string;
  readonly tagClass: string;
  readonly title: string;
  readonly evidence: string;
  readonly result: string;
  /** The `ok` code the decision's redirect carries. */
  readonly ok: string;
}

export function NoticedDecision({
  snapshot,
  className,
  testId,
  children,
}: {
  snapshot: NoticedSnapshot;
  className: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      className={className}
      data-testid={testId}
      onClick={() => {
        try {
          window.sessionStorage.setItem(KEY, JSON.stringify(snapshot));
        } catch {
          // Storage refused: the decision still posts; the card simply goes.
        }
      }}
    >
      {children}
    </button>
  );
}

export function NoticedDecided() {
  const [card, setCard] = useState<NoticedSnapshot | null>(null);
  // Keyed to the redirect's `ok`: the page re-renders in place after the
  // decision's form post, so this component is not mounted afresh.
  const ok = useSearchParams().get('ok');
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(KEY);
      if (raw) window.sessionStorage.removeItem(KEY);
    } catch {
      return;
    }
    if (!raw) {
      if (!ok) setCard(null);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as NoticedSnapshot;
      setCard(parsed && typeof parsed.title === 'string' && parsed.ok === ok ? parsed : null);
    } catch {
      setCard(null);
    }
  }, [ok]);
  if (!card) return null;
  return (
    <div className="bsp-xcard bsp-home-decided" data-testid={`home-decided-${card.id}`}>
      <span className="bsp-home-decided-h">
        <span className="bsp-xicon" aria-hidden="true">
          {card.glyph}
        </span>
        <span className={card.tagClass}>{card.tag}</span>
      </span>
      <span className="bsp-xtitle bsp-home-decided-t">{card.title}</span>
      <span className="bsp-xdesc">{card.evidence}</span>
      <span className="bsp-pill bsp-p-ok bsp-home-decided-pill" role="status">
        {card.result}
      </span>
    </div>
  );
}
