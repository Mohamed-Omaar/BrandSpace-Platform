'use client';

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * Batch 7 PR C (2d) — "SEND IT AGAIN" SAYS WHEN IT CAN. The cooldown is the
 * configured one (`verificationResendCooldownSeconds`), counted from the last
 * press on THIS page — never from the account, so the page still says nothing
 * about whether the address has one. During it the button is disabled and
 * reads "You can send it again in 0:45"; while sending it reads "Sending…".
 */
export function ResendButton({
  sentAt,
  waitSeconds,
  label,
  waitLabel,
  sendingLabel,
  style,
}: {
  /** Epoch milliseconds of the last send asked for, or null. */
  readonly sentAt: number | null;
  readonly waitSeconds: number;
  readonly label: string;
  /** "You can send it again in {time}". */
  readonly waitLabel: string;
  readonly sendingLabel: string;
  readonly style?: CSSProperties;
}) {
  const { pending } = useFormStatus();
  const remainingAt = (now: number) =>
    sentAt === null ? 0 : Math.max(0, Math.ceil((sentAt + waitSeconds * 1_000 - now) / 1_000));
  const [remaining, setRemaining] = useState(() => remainingAt(Date.now()));
  useEffect(() => {
    setRemaining(remainingAt(Date.now()));
    if (sentAt === null) return undefined;
    const timer = window.setInterval(() => {
      const next = remainingAt(Date.now());
      setRemaining(next);
      if (next === 0) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
    // The countdown restarts only when a new send is recorded.
  }, [sentAt, waitSeconds]);
  const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  return (
    <button
      type="submit"
      style={style}
      disabled={pending || remaining > 0}
      aria-busy={pending || undefined}
      data-testid="signup-resend"
      data-wait={remaining}
    >
      {pending ? sendingLabel : remaining > 0 ? waitLabel.replace('{time}', clock) : label}
    </button>
  );
}
