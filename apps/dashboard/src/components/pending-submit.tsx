'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * Batch 7 PR C (2d) — A SUBMIT BUTTON THAT SAYS IT IS WORKING. The sign-up
 * button had no pending state, so a second press while the first was on its
 * way sent a second email. While its form is being sent it is disabled and
 * reads `pendingLabel`.
 */
export function PendingSubmit({
  label,
  pendingLabel,
  style,
  testId,
  disabled = false,
}: {
  readonly label: ReactNode;
  readonly pendingLabel: ReactNode;
  readonly style?: CSSProperties;
  readonly testId?: string;
  readonly disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      style={style}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      data-testid={testId}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
