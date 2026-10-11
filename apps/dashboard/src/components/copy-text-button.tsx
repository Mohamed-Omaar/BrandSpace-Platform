'use client';

import { showToast } from '@brandspace/ui';

/**
 * PR D (Settings 8) — "Copy" beside a value, and a toast that says it was
 * copied (the prototype's set-up key, `x.tfa.copyKey`). The value is already on
 * the screen; this only puts it on the clipboard. A refused clipboard says so.
 */
export function CopyTextButton({
  value,
  label,
  copied,
  failed,
  className,
  testId,
}: {
  readonly value: string;
  readonly label: string;
  readonly copied: string;
  readonly failed: string;
  readonly className: string;
  readonly testId: string;
}) {
  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      onClick={() => {
        const done = (ok: boolean) =>
          showToast({
            tone: ok ? 'success' : 'error',
            message: ok ? copied : failed,
            testId: `${testId}-toast`,
          });
        try {
          void navigator.clipboard.writeText(value).then(
            () => done(true),
            () => done(false),
          );
        } catch {
          done(false);
        }
      }}
    >
      {label}
    </button>
  );
}
