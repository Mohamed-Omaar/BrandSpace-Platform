'use client';

import { useId, useState, type CSSProperties } from 'react';
import { Field, inputStyle, CONTROL_CLASS } from './primitives';
import { colorTokens, radiusTokens, spacingTokens, typographyTokens } from './tokens';

/**
 * The password control: a field, a Show/Hide toggle, and — where one is wanted —
 * a confirmation that reports a mismatch as it is typed (P6-03a).
 *
 * WHY THIS IS ONE COMPONENT AND NOT FOUR COPIES. Sign-up, password reset,
 * invitation acceptance and the security screen all ask for a password, and
 * before this each hand-rolled its own `<input type="password">`. That is how
 * three of them came to hard-code a minimum length the fourth read from
 * configuration, and why none of them had a reveal toggle: a reveal is an
 * interaction, so adding it once per screen means adding it four times, with
 * four chances to get the accessible name or the RTL placement wrong.
 *
 * THE TOGGLE IS NOT DECORATION. A password field that cannot be revealed pushes
 * people toward short passwords they are sure they can type, which is the
 * opposite of what a length-first policy is for — and on a phone keyboard it is
 * the difference between a passphrase and a word. It is a real `<button>` with
 * a real accessible name that CHANGES with the state, and `aria-pressed`, so a
 * screen reader user knows whether their password is currently visible on a
 * screen other people might see.
 *
 * THE CONFIRMATION IS THE CLIENT'S COURTESY, NOT THE SERVER'S RULE. Comparing
 * the two fields here catches a typo before the form is submitted and an
 * emailed reset link is spent. IT PROVES NOTHING, and every server action in
 * this product validates the password itself and never reads the confirmation:
 * a client that omits it, or sends two values that differ, changes nothing
 * about what is accepted. Treating a client-side match as authorisation would
 * be trusting the caller to check their own input.
 *
 * NO PASSWORD VALUE IS EVER LOGGED, MEASURED OR REPORTED. The component holds
 * the two values in state to compare their equality and their length, and does
 * nothing else with them — no analytics, no strength meter phoning anywhere, no
 * value in a `data-` attribute. The only things it derives are three booleans.
 *
 * NO NEW VISUAL LANGUAGE (CLAUDE.md §4.2 rule 5). It composes `Field`,
 * `inputStyle()` and the existing tokens; the toggle is a ghost control at the
 * field's own scale, positioned with LOGICAL properties so Arabic mirrors it
 * without a second stylesheet.
 */

/**
 * One line of the rules list.
 *
 * `kind` decides who evaluates it, and the split is not cosmetic: every caller
 * of this component is a SERVER component, so it cannot hand over a predicate
 * and cannot see what is being typed. A rule whose `met` was computed at the
 * call site would therefore be frozen at whatever the server rendered — which
 * is how the first draft of this shipped a length rule permanently showing
 * "not met" while the customer typed a valid password.
 *
 *   - `min-length` is evaluated HERE, against the value this component holds.
 *   - `note` is guidance that is always true (that a passphrase is welcome),
 *     so it carries no state and no tick to be wrong about.
 */
export interface PasswordRule {
  /** The rule as the customer reads it, in their language. */
  readonly label: string;
  readonly kind: 'min-length' | 'note';
}

export interface PasswordFieldLabels {
  readonly label: string;
  readonly show: string;
  readonly hide: string;
  /** The confirmation field's label. Omit the confirm block by omitting this. */
  readonly confirmLabel?: string | undefined;
  readonly mismatch?: string | undefined;
  readonly match?: string | undefined;
  /** Names the rules list for assistive technology, e.g. "Password rules". */
  readonly rulesLabel?: string | undefined;
}

/**
 * The reveal toggle.
 *
 * Its own component so the two fields cannot drift apart, and so the button is
 * described in one place rather than twice.
 */
function RevealToggle({
  shown,
  onToggle,
  labels,
  controls,
}: {
  readonly shown: boolean;
  readonly onToggle: () => void;
  readonly labels: { readonly show: string; readonly hide: string };
  readonly controls: string;
}) {
  const style: CSSProperties = {
    position: 'absolute',
    /*
     * LOGICAL, so Arabic puts it on the reader's trailing edge rather than
     * physically on the right. `insetInlineEnd` is the same rule the shell uses
     * (D-59's RTL contract); `right` here would have put the toggle over the
     * first character of an Arabic password.
     */
    insetInlineEnd: spacingTokens.xs,
    insetBlockStart: '50%',
    transform: 'translateY(-50%)',
    display: 'inline-flex',
    alignItems: 'center',
    minBlockSize: '1.75rem',
    paddingInline: spacingTokens.sm,
    border: '1px solid transparent',
    borderRadius: radiusTokens.md,
    background: 'transparent',
    color: colorTokens.textSecondary,
    ...typographyTokens.caption,
    fontWeight: 700,
    cursor: 'pointer',
  };

  return (
    <button
      type="button"
      onClick={onToggle}
      className="bs-pressable bs-control"
      style={style}
      /*
       * THE NAME CHANGES WITH THE STATE, and `aria-pressed` carries the state
       * itself. A button labelled only "Show password" that is currently
       * showing it tells a screen reader user the opposite of what is true —
       * and whether a password is legible on screen is exactly the thing
       * somebody in an open-plan office needs to know.
       */
      aria-pressed={shown}
      aria-controls={controls}
      aria-label={shown ? labels.hide : labels.show}
    >
      <span aria-hidden="true">{shown ? labels.hide : labels.show}</span>
    </button>
  );
}

export function PasswordField({
  id,
  name = 'password',
  labels,
  minLength,
  maxLength,
  required = true,
  autoComplete = 'new-password',
  rules,
  error,
  testId,
  defaultShown = false,
}: {
  readonly id: string;
  readonly name?: string;
  readonly labels: PasswordFieldLabels;
  /** The CONFIGURED minimum. Never a number written at the call site. */
  readonly minLength: number;
  readonly maxLength?: number | undefined;
  readonly required?: boolean;
  readonly autoComplete?: 'new-password' | 'current-password';
  /**
   * The rules, stated BEFORE anything is typed and ticked off as they are met.
   *
   * A rule the customer only discovers by failing it is a rule the form kept
   * secret. A `min-length` line is evaluated HERE against the value this
   * component holds — the caller is a server component and cannot see it — and
   * a `note` is guidance that is always true.
   */
  readonly rules?: readonly PasswordRule[] | undefined;
  readonly error?: string | undefined;
  /**
   * The test id for the password input.
   *
   * Explicit rather than derived, so adopting this component does not silently
   * rename a selector an end-to-end suite already depends on — `id` and
   * `data-testid` are not the same name on every screen that existed first.
   * Defaults to `<id>-input`.
   */
  readonly testId?: string | undefined;
  /** Only for tests and stories; a password starts hidden for everyone else. */
  readonly defaultShown?: boolean;
}) {
  const [shown, setShown] = useState(defaultShown);
  const [confirmShown, setConfirmShown] = useState(false);
  const [value, setValue] = useState('');
  const [confirmValue, setConfirmValue] = useState('');
  const generated = useId();
  const confirmId = `${id}-confirm`;
  const rulesId = `${generated}-rules`;

  const wantsConfirm = labels.confirmLabel !== undefined;
  // Only once BOTH have something in them: reporting a mismatch against an
  // empty box calls somebody wrong for not having finished typing.
  const compared = wantsConfirm && value !== '' && confirmValue !== '';
  const mismatched = compared && value !== confirmValue;
  const matched = compared && value === confirmValue;

  const wrapper: CSSProperties = { position: 'relative' };
  // Room for the toggle, on the trailing edge, logically.
  const field: CSSProperties = { ...inputStyle(), paddingInlineEnd: '4.5rem' };

  return (
    <>
      <Field label={labels.label} htmlFor={id} required={required} {...(error ? { error } : {})}>
        <div style={wrapper}>
          <input
            className={CONTROL_CLASS}
            id={id}
            name={name}
            type={shown ? 'text' : 'password'}
            required={required}
            minLength={minLength}
            {...(maxLength === undefined ? {} : { maxLength })}
            autoComplete={autoComplete}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            {...(rules && rules.length > 0 ? { 'aria-describedby': rulesId } : {})}
            style={field}
            data-testid={testId ?? `${id}-input`}
          />
          <RevealToggle
            shown={shown}
            onToggle={() => setShown((previous) => !previous)}
            labels={labels}
            controls={id}
          />
        </div>
      </Field>

      {rules && rules.length > 0 ? (
        <ul
          id={rulesId}
          aria-label={labels.rulesLabel ?? labels.label}
          style={{
            margin: `-${spacingTokens.sm} 0 ${spacingTokens.md}`,
            padding: 0,
            listStyle: 'none',
            display: 'grid',
            gap: spacingTokens['3xs'],
          }}
          data-testid={`${id}-rules`}
        >
          {rules.map((rule) => {
            // A note is never "unmet" — it is advice, not a test — so it is
            // rendered plainly rather than as a box waiting to be ticked.
            const checkable = rule.kind === 'min-length';
            const met = checkable && value.length >= minLength;
            return (
              <li
                key={rule.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: spacingTokens.xs,
                  ...typographyTokens.caption,
                  color: met ? colorTokens.success : colorTokens.textSecondary,
                }}
                data-met={checkable ? (met ? 'yes' : 'no') : undefined}
              >
                {/*
                  THE TICK IS NOT THE ONLY SIGNAL. Colour alone fails WCAG
                  1.4.1, so the glyph changes too; it is `aria-hidden` because
                  the sentence beside it is what a reader needs, and `data-met`
                  is what the tests read.
                */}
                <span aria-hidden="true">{checkable ? (met ? '✓' : '○') : '·'}</span>
                {rule.label}
              </li>
            );
          })}
        </ul>
      ) : null}

      {wantsConfirm ? (
        <Field
          label={labels.confirmLabel as string}
          htmlFor={confirmId}
          required={required}
          {...(mismatched && labels.mismatch ? { error: labels.mismatch } : {})}
          {...(matched && labels.match ? { success: labels.match } : {})}
        >
          <div style={wrapper}>
            <input
              className={CONTROL_CLASS}
              id={confirmId}
              /*
               * DELIBERATELY UNNAMED — it is not submitted at all.
               *
               * The server validates the password and never reads a
               * confirmation, so sending one would be shipping a field whose
               * only possible use is to be trusted by mistake.
               */
              type={confirmShown ? 'text' : 'password'}
              required={required}
              autoComplete={autoComplete}
              value={confirmValue}
              onChange={(event) => setConfirmValue(event.target.value)}
              aria-invalid={mismatched || undefined}
              style={field}
              data-testid={`${id}-confirm-input`}
            />
            <RevealToggle
              shown={confirmShown}
              onToggle={() => setConfirmShown((previous) => !previous)}
              labels={labels}
              controls={confirmId}
            />
          </div>
        </Field>
      ) : null}
    </>
  );
}
