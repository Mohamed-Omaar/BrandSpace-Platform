'use client';

import { useEffect, useState } from 'react';

/**
 * D-496 (Brand Brain 1, Strategy 1) — THE PROTOTYPE'S FIRST-VISIT HINT CARD
 * (`Main.dc.html` L759 and L977): a lavender note with 💡, one sentence and ×.
 *
 * DISMISSED IN THIS BROWSER (owner decision, D-496): × stores the key in
 * `localStorage`, as the prototype's `hintSeen` does. Nothing is stored on the
 * server and nothing is shared between people. Read only after mounting, so
 * the server's HTML never depends on it; a browser that refuses storage simply
 * shows the hint again next time.
 */
export function FirstVisitHint({
  storageKey,
  text,
  closeLabel,
  testId,
}: {
  readonly storageKey: string;
  readonly text: string;
  readonly closeLabel: string;
  readonly testId: string;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    try {
      setShown(window.localStorage.getItem(storageKey) !== '1');
    } catch {
      setShown(true);
    }
  }, [storageKey]);
  if (!shown) return null;
  return (
    <div role="note" className="bsp-hint-card" data-testid={testId}>
      <span aria-hidden="true">💡</span>
      <span className="bsp-hint-card-t">{text}</span>
      <button
        type="button"
        className="bsp-hint-card-x"
        aria-label={closeLabel}
        data-testid={`${testId}-close`}
        onClick={() => {
          setShown(false);
          try {
            window.localStorage.setItem(storageKey, '1');
          } catch {
            // Storage refused: hidden for this visit only.
          }
        }}
      >
        ×
      </button>
    </div>
  );
}
