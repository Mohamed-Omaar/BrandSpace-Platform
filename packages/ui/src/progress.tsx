'use client';

import { useEffect, useState } from 'react';
import { Spinner } from './primitives';
import { elapsedText } from './progress-time';

/**
 * WAITING, MADE VISIBLE (P1). Shared pieces, so no screen invents its own: a
 * bar for work whose share is known (an upload) and a status line for work
 * whose length is not (an image being generated). Every word is the caller's,
 * in the caller's language; the components draw only tokens. The waiting
 * submit button needs `react-dom`'s form status, so it lives with the app:
 * `apps/dashboard/src/components/pending-submit.tsx`.
 */

/** A determinate bar: "34%" while a file goes up. `value` is 0-100. */
export function ProgressBar({
  value,
  label,
  testId = 'progress',
}: {
  readonly value: number;
  /** What is in progress, e.g. "Uploading photo.png". Read by screen readers. */
  readonly label: string;
  readonly testId?: string;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <span className="bs-progress" data-testid={testId}>
      <progress className="bs-progress-bar" max={100} value={percent} aria-label={label} />
      <span className="bs-progress-value" data-testid={`${testId}-value`} aria-hidden="true">
        {percent}%
      </span>
    </span>
  );
}

/**
 * Work whose length is unknown: a spinner, what is happening, and how long it
 * has taken so far, ticking once a second. A polite live region, so a screen
 * reader hears the label once rather than every tick.
 */
export function WorkingStatus({
  label,
  since,
  testId = 'working',
}: {
  readonly label: string;
  /** `Date.now()` when the work started. */
  readonly since: number;
  readonly testId?: string;
}) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return (
    <span className="bs-working" role="status" aria-live="polite" data-testid={testId}>
      <Spinner />
      <span>{label}</span>
      <span className="bs-working-time" data-testid={`${testId}-time`} aria-hidden="true">
        {elapsedText(since, now)}
      </span>
    </span>
  );
}
