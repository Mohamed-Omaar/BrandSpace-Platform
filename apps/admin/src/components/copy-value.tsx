'use client';

import { useState } from 'react';
import { buttonStyle } from '@brandspace/ui';

/**
 * COPY A VALUE BRANDSPACE GENERATED — a callback, a webhook, a deauthorize or
 * data-deletion address the owner pastes into a platform's own console.
 *
 * Built from the design system's own neutral button (CLAUDE.md §4.2 rule 4,
 * reuse before creating); the only behaviour it adds is the clipboard and a
 * polite live region that says it worked, so a screen-reader user hears the
 * same confirmation a sighted one sees. Never used for a secret: a secret is
 * never readable again after it is saved, so there is nothing to copy.
 */
/** Visually hidden, still announced. */
const announcerStyle = {
  position: 'absolute',
  inlineSize: 1,
  blockSize: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
} as const;

export function CopyValue({
  value,
  text,
  label,
  copiedLabel,
  failedLabel,
  testId,
}: {
  readonly value: string;
  /** The word on the button: "Copy". */
  readonly text: string;
  /** The button's accessible name, e.g. "Copy the Facebook redirect URL". */
  readonly label: string;
  readonly copiedLabel: string;
  readonly failedLabel: string;
  readonly testId?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        aria-label={label}
        data-testid={testId}
        style={buttonStyle('neutral', 'sm')}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState('copied');
          } catch {
            setState('failed');
          }
        }}
      >
        {state === 'copied' ? copiedLabel : text}
      </button>
      <span role="status" aria-live="polite" style={announcerStyle}>
        {state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : ''}
      </span>
    </span>
  );
}
