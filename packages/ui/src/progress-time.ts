/**
 * P1 — the elapsed-time text `WorkingStatus` shows, in a neutral module so a
 * server component (or a test) can use it without importing a client module.
 */

/** "0:07" — minutes and seconds since `since`, in Western digits in both languages. */
export function elapsedText(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
