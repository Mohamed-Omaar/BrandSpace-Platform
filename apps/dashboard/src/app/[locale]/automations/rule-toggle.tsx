'use client';

import { useState } from 'react';
import type { ToggleResult } from './actions';

/**
 * ROUND 4 (5.2) — THE RULE'S STATE AND ITS SWITCH, TURNED IN PLACE.
 *
 * The prototype's switch changes only itself and the "On / Off" beside it.
 * This posts the row's own form to the same `toggleAutomationAction`, asked
 * for an answer (`inPlace=1`) instead of a redirect — the list does not
 * reload, flicker or reset. Without script the form still posts and
 * redirects as it always did.
 *
 * A CLICK IS NEVER LOST (PR A, owner 2026-11-12). The switch used to flip at
 * once and then silently ignore any click until the server answered, so a
 * quick second click (off, then on again) did nothing and the rule stayed
 * off. Now, while a request is in flight, the switch shows where it is going
 * and is BUSY: `disabled` and `aria-busy`, so a second click cannot be taken
 * and then dropped. When the server answers, the switch shows the SERVER's
 * state; a refusal puts it back and says why, in the screen's own words for
 * that refusal.
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
  /** The words when the refusal has none of its own. */
  readonly failedLabel: string;
  readonly action: (formData: FormData) => Promise<void | ToggleResult>;
}) {
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
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
          // The button is disabled while busy, so this is only a guard.
          if (busy) return;
          const data = new FormData(event.currentTarget);
          data.set('inPlace', '1');
          const before = on;
          setOn(!before);
          setBusy(true);
          setFailure(null);
          void action(data)
            .then((result) => {
              if (result && !result.ok) {
                setOn(before);
                setFailure(result.message ?? failedLabel);
              } else if (result) {
                setOn(result.enabled);
              }
            })
            .catch(() => {
              setOn(before);
              setFailure(failedLabel);
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
          disabled={busy}
          aria-busy={busy || undefined}
          aria-label={on ? label.on : label.off}
          data-testid={`automation-toggle-${ruleId}`}
        >
          <span className="bsp-tgl-k" aria-hidden="true" />
        </button>
      </form>
      {failure !== null ? (
        <span
          className="bsp-au-tgl-failed"
          role="alert"
          data-testid={`automation-toggle-failed-${ruleId}`}
        >
          {failure}
        </span>
      ) : null}
    </>
  );
}
