'use client';

import { useEffect, useState } from 'react';
import { OPEN_COPILOT_EVENT } from '../../../../components/copilot-link';

/**
 * THE STUDIO BAR'S ROUND COPILOT BUTTON — `Main.dc.html` line 533 (review of
 * #67, round 2).
 *
 * On the Studio the prototype hides the floating Copilot (`fabUp`) and ends
 * the sticky bar with this 40px purple circle instead, after a 1×24px rule.
 * It opens the SAME panel the floating button opens (the shell's
 * `GlobalCopilot`, through its open event), so it is drawn only where that
 * panel exists — where the floating button would have been drawn.
 */
export function StudioCopilotButton({ label }: { readonly label: string }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    setAvailable(document.querySelector('[data-testid="global-copilot-trigger"]') !== null);
  }, []);
  if (!available) return null;
  return (
    <>
      <span aria-hidden="true" className="bsp-st-rule" />
      <button
        type="button"
        className="bsp-st-cp"
        aria-label={label}
        title={label}
        data-testid="studio-copilot"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent(OPEN_COPILOT_EVENT, { cancelable: true, detail: { request: '' } }),
          )
        }
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5l-1.6-5.3L5 10.6 10.4 9z" />
        </svg>
      </button>
    </>
  );
}
