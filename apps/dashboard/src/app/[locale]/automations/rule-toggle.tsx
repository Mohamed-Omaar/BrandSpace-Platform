'use client';

import { useState } from 'react';
import type { ToggleResult } from './actions';

/**
 * ROUND 4 (5.2) — THE RULE'S STATE AND ITS SWITCH, TURNED IN PLACE.
 *
 * The prototype's switch changes only itself and the "On / Off" beside it.
 * This posts the row's own form to the same `toggleAutomationAction`, asked
 * for an answer (`inPlace=1`) instead of a redirect, and shows the new state
 * when the server has kept it — the list does not reload, flicker or reset.
 * A refusal puts the switch back and says why. Without script the form still
 * posts and redirects as it always did.
 */
export function RuleToggle({
  locale,
  ruleId,
  enabled,
  label,
  onLabel,
  offLabel,
  failedLabel,
  action,
}: {
  readonly locale: string;
  readonly ruleId: string;
  readonly enabled: boolean;
  /** "Turn off: <rule>" / "Turn on: <rule>", for each state. */
  readonly label: { readonly on: string; readonly off: string };
  readonly onLabel: string;
  readonly offLabel: string;
  readonly failedLabel: string;
  readonly action: (formData: FormData) => Promise<void | ToggleResult>;
}) {
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <span
        className={`bsp-xstatus${on ? '' : ' bsp-neu'}`}
        data-testid={`automation-state-${ruleId}`}
      >
        {on ? onLabel : offLabel}
      </span>
      <form
        action={action as (formData: FormData) => Promise<void>}
        className="bsp-au-tglf"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const data = new FormData(event.currentTarget);
          data.set('inPlace', '1');
          const next = !on;
          setOn(next);
          setBusy(true);
          setFailed(false);
          void action(data)
            .then((result) => {
              if (result && !result.ok) {
                setOn(!next);
                setFailed(true);
              }
            })
            .catch(() => {
              setOn(!next);
              setFailed(true);
            })
            .finally(() => setBusy(false));
        }}
      >
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="ruleId" value={ruleId} />
        <input type="hidden" name="enabled" value={on ? '0' : '1'} />
        <button
          type="submit"
          className="bsp-tgl"
          aria-pressed={on}
          aria-busy={busy || undefined}
          aria-label={on ? label.on : label.off}
          data-testid={`automation-toggle-${ruleId}`}
        >
          <span className="bsp-tgl-k" aria-hidden="true" />
        </button>
      </form>
      {failed ? (
        <span
          className="bsp-au-tgl-failed"
          role="alert"
          data-testid={`automation-toggle-failed-${ruleId}`}
        >
          {failedLabel}
        </span>
      ) : null}
    </>
  );
}
