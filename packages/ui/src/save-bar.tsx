'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { CheckIcon } from './icons';
import { buttonStyle } from './primitives';
import {
  colorTokens,
  radiusTokens,
  shadowTokens,
  spacingTokens,
  typographyTokens,
  zIndexTokens,
} from './tokens';

/**
 * THE SETTINGS SAVE BAR (A9 / G1, prototype v94 Phase 2B-1).
 *
 * One bar under every draftable Settings tab, so a change is never saved by
 * accident and never lost without being told:
 *
 *   - clean — "All changes saved", and Save is disabled;
 *   - dirty — "Unsaved changes", with Cancel (put the saved values back) and Save.
 *
 * AN APPROVED DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2, UI-FIDELITY §6.3.33):
 * the approved demo has no save bar. It is composed from what already ships —
 * the card surface and its shadow, the ghost and primary buttons, the caption
 * type and the check icon — and sticks to the bottom of its form with
 * `position: sticky`, so it never covers a field the page scrolls past.
 */
export interface SaveBarLabels {
  readonly saved: string;
  readonly unsaved: string;
  readonly cancel: string;
  readonly save: string;
}

export function SaveBar({
  dirty,
  labels,
  onCancel,
  saveTestId,
  testId = 'save-bar',
}: {
  readonly dirty: boolean;
  readonly labels: SaveBarLabels;
  readonly onCancel: () => void;
  /** The Save button's test id — kept per form so existing journeys still find it. */
  readonly saveTestId?: string | undefined;
  readonly testId?: string | undefined;
}) {
  const bar: CSSProperties = {
    position: 'sticky',
    insetBlockEnd: spacingTokens.sm,
    zIndex: zIndexTokens.sticky,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacingTokens.sm,
    padding: `${spacingTokens.sm} ${spacingTokens.md}`,
    borderRadius: radiusTokens.xl,
    background: colorTokens.surface,
    border: `1px solid ${colorTokens.cardBorder}`,
    boxShadow: shadowTokens.card,
  };
  return (
    <div data-testid={testId} data-state={dirty ? 'dirty' : 'clean'} style={bar}>
      <span
        role="status"
        aria-live="polite"
        data-testid={`${testId}-status`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: spacingTokens.xs,
          ...typographyTokens.bodySm,
          color: dirty ? colorTokens.textPrimary : colorTokens.textMuted,
          fontWeight: dirty ? 600 : 400,
        }}
      >
        {dirty ? null : <CheckIcon size={16} />}
        {dirty ? labels.unsaved : labels.saved}
      </span>
      <span style={{ display: 'inline-flex', gap: spacingTokens.xs }}>
        {dirty ? (
          <button
            type="button"
            onClick={onCancel}
            data-testid={`${testId}-cancel`}
            style={buttonStyle('ghost')}
          >
            {labels.cancel}
          </button>
        ) : null}
        <button
          type="submit"
          disabled={!dirty}
          aria-disabled={!dirty}
          data-testid={saveTestId ?? `${testId}-save`}
          style={{
            ...buttonStyle('primary'),
            ...(dirty ? null : { opacity: 0.45, cursor: 'not-allowed' }),
          }}
        >
          {labels.save}
        </button>
      </span>
    </div>
  );
}

/** Every value the form would post, in order — what "unchanged" is compared on. */
function snapshotOf(form: HTMLFormElement): string {
  const entries: [string, string][] = [];
  for (const [key, value] of new FormData(form)) {
    entries.push([key, typeof value === 'string' ? value : value.name]);
  }
  return JSON.stringify(entries);
}

/**
 * A SERVER-ACTION FORM THAT KNOWS WHETHER IT HAS CHANGED.
 *
 * The form still posts to its server action exactly as before; nothing is
 * saved from the browser. What this adds is the save bar's state: the posted
 * values are read once when the form mounts and compared after every
 * interaction. Cancel re-mounts the fields, which puts every control — a plain
 * input, a checkbox or a controlled picker — back to the value the server
 * rendered.
 *
 * The caller keys the form on the SAVED values, so a successful save (which
 * re-renders the page with new ones) starts a fresh, clean form.
 */
export function DraftForm({
  action,
  children,
  labels,
  saveTestId,
  testId,
  barTestId,
  style,
}: {
  readonly action: (formData: FormData) => void | Promise<void>;
  readonly children: ReactNode;
  readonly labels: SaveBarLabels;
  readonly saveTestId?: string | undefined;
  readonly testId?: string | undefined;
  readonly barTestId?: string | undefined;
  readonly style?: CSSProperties | undefined;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const saved = useRef<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);

  const measure = useCallback(() => {
    const form = formRef.current;
    if (!form || saved.current === null) return;
    setDirty(snapshotOf(form) !== saved.current);
  }, []);

  // The saved state, read after the fields (and any controlled picker's hidden
  // input) have rendered — and again after a Cancel re-mounted them.
  useEffect(() => {
    if (formRef.current) saved.current = snapshotOf(formRef.current);
    setDirty(false);
  }, [generation]);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    // After the event, not during it: a controlled picker writes its hidden
    // input when React commits the state its click set.
    const later = () => window.setTimeout(measure, 0);
    const events = ['input', 'change', 'click', 'keyup'] as const;
    for (const name of events) form.addEventListener(name, later);
    return () => {
      for (const name of events) form.removeEventListener(name, later);
    };
  }, [measure]);

  return (
    <form ref={formRef} action={action} data-testid={testId} style={style}>
      <Fragment key={generation}>{children}</Fragment>
      <SaveBar
        dirty={dirty}
        labels={labels}
        onCancel={() => setGeneration((value) => value + 1)}
        saveTestId={saveTestId}
        testId={barTestId}
      />
    </form>
  );
}
