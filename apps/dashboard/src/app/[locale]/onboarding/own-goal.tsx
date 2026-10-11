'use client';

import { useState } from 'react';
import { OWN_GOAL_MAX } from '../../../server/setup-wizard-state';

/**
 * D-496 (Auth 8) — "+ ADD YOUR OWN" GOAL (`Auth.dc.html` L183–185, logic
 * L291–293): the dashed chip opens a field and "Add"; adding makes the typed
 * goal a chip of its own, chosen. It is one more choice of the same `goal`
 * radio group (`own`), its words posted beside it as `ownGoal`, so Continue
 * saves it like any other goal.
 */
export function OwnGoal({
  openLabel,
  placeholder,
  addLabel,
  initial,
}: {
  readonly openLabel: string;
  readonly placeholder: string;
  readonly addLabel: string;
  /** A typed goal already saved, shown as its chip and chosen. */
  readonly initial: string | null;
}) {
  const [own, setOwn] = useState<string | null>(initial);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const add = () => {
    const goal = text.trim().slice(0, OWN_GOAL_MAX);
    if (goal === '') return;
    setOwn(goal);
    setText('');
    setAdding(false);
  };
  return (
    <>
      {own ? (
        <label key={own} className="bsp-wz-chip">
          <input
            type="radio"
            name="goal"
            value="own"
            required
            defaultChecked
            className="bsp-wz-radio"
            data-testid="setup-goal-own"
          />
          <bdi>{own}</bdi>
          <input type="hidden" name="ownGoal" value={own} />
        </label>
      ) : null}
      {adding ? (
        <div className="bsp-wz-own">
          <input
            className="bs-control bsp-wz-own-in"
            dir="auto"
            value={text}
            maxLength={OWN_GOAL_MAX}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            // The prototype's `autofocus` (L184): the field opens to be typed in.
            autoFocus
            data-testid="setup-goal-own-input"
          />
          <button
            type="button"
            className="bsp-wz-chip bsp-wz-own-add"
            onClick={add}
            data-testid="setup-goal-own-add"
          >
            {addLabel}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="bsp-wz-chip bsp-wz-own-open"
          onClick={() => setAdding(true)}
          data-testid="setup-goal-own-open"
        >
          {openLabel}
        </button>
      )}
    </>
  );
}
