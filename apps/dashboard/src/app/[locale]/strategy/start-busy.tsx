'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

const BusyContext = createContext<((busy: boolean) => void) | null>(null);

/**
 * PR D (Strategy 10) — THE AI START'S BUSY CARD (`x.sp.busy`, Main line 993):
 * while the strategy is being written, the ways to start give way to one card,
 * "✦ Brandspace is reading your results and brand knowledge…". The form stays
 * mounted (hidden) so its action runs to the end; the card goes when the
 * action's navigation lands, success or refusal, because it follows the
 * form's own pending state rather than a flag of its own.
 */
export function StartBusy({ label, children }: { label: string; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <BusyContext.Provider value={setBusy}>
      {busy ? (
        <section className="bsp-xcard bsp-sp-busy" role="status" data-testid="strategy-busy">
          <span className="bsp-xicon" aria-hidden="true">
            ✦
          </span>
          <span className="bsp-sp-busy-t">{label}</span>
        </section>
      ) : null}
      <div style={{ display: busy ? 'none' : 'contents' }}>{children}</div>
    </BusyContext.Provider>
  );
}

/** Inside the form: reports its pending state to the nearest `StartBusy`. */
export function StartBusyReporter() {
  const { pending } = useFormStatus();
  const setBusy = useContext(BusyContext);
  useEffect(() => {
    setBusy?.(pending);
  }, [pending, setBusy]);
  useEffect(() => () => setBusy?.(false), [setBusy]);
  return null;
}
