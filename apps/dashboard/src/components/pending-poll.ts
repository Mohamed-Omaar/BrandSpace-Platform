/**
 * B1 (performance) — THE TIMING OF `PendingWatch`, with no React and no DOM,
 * so a unit test drives it with a fake clock. See `pending-watch.tsx`.
 */

export const PENDING_DELAYS_MS = [2_500, 2_500, 5_000, 5_000, 10_000, 10_000] as const;
export const PENDING_MAX_DELAY_MS = 15_000;
export const PENDING_STOP_AFTER_MS = 10 * 60_000;

/** The wait before the `attempt`-th question (0-based). */
export function pendingDelay(attempt: number): number {
  return PENDING_DELAYS_MS[attempt] ?? PENDING_MAX_DELAY_MS;
}

/** What the poll needs from the page; a test passes fakes. */
export interface PendingPollHost {
  /** Asks the status route; `null` when it could not answer (try again later). */
  readonly ask: () => Promise<Record<string, boolean> | null>;
  readonly now: () => number;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
  readonly hidden: () => boolean;
  /** Something finished: re-read the page once. */
  readonly onFinished: () => void;
  /** The time is up: say so. */
  readonly onStopped: () => void;
}

/**
 * The poll itself, with no React and no DOM, so its timing is tested exactly.
 * Returns `visibilityChanged` (call it on `visibilitychange`) and `stop`.
 */
export function startPendingPoll(
  host: PendingPollHost,
  stopAfterMs: number = PENDING_STOP_AFTER_MS,
): { readonly visibilityChanged: () => void; readonly stop: () => void } {
  const started = host.now();
  let attempt = 0;
  let timer: unknown;
  let asking = false;
  let done = false;

  const schedule = () => {
    if (done || asking || timer !== undefined || host.hidden()) return;
    timer = host.setTimer(() => {
      timer = undefined;
      void ask();
    }, pendingDelay(attempt));
  };
  const ask = async () => {
    if (done || asking) return;
    // Past the limit, this is the LAST question: finished → re-read, otherwise
    // stop and say so. (A tab hidden for an hour gets one check on return.)
    const last = host.now() - started >= stopAfterMs;
    asking = true;
    const pending = await host.ask().catch(() => null);
    asking = false;
    if (done) return;
    if (pending && Object.values(pending).some((going) => going === false)) {
      done = true;
      host.onFinished();
      return;
    }
    if (last) {
      done = true;
      host.onStopped();
      return;
    }
    attempt += 1;
    schedule();
  };

  schedule();
  return {
    visibilityChanged: () => {
      if (done) return;
      if (host.hidden()) {
        if (timer !== undefined) host.clearTimer(timer);
        timer = undefined;
      } else if (timer === undefined) {
        void ask();
      }
    },
    stop: () => {
      done = true;
      if (timer !== undefined) host.clearTimer(timer);
      timer = undefined;
    },
  };
}
