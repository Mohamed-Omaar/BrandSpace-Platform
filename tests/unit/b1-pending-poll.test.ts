import { describe, expect, it } from 'vitest';
import {
  PENDING_STOP_AFTER_MS,
  pendingDelay,
  startPendingPoll,
} from '../../apps/dashboard/src/components/pending-poll';

/**
 * B1 (owner, 2026-11-14) — A FILE STILL GOING IS FOLLOWED CHEAPLY: a small
 * status question with back-off, nothing at all while the tab is hidden, a
 * single page re-read when it finishes, and an honest stop after ten minutes.
 */

/** Lets every pending promise (the answer and what follows it) run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(answers: (Record<string, boolean> | null)[] = []) {
  let clock = 0;
  let hidden = false;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  const asked: number[] = [];
  const events: string[] = [];
  const poll = startPendingPoll({
    ask: async () => {
      asked.push(clock);
      return answers.shift() ?? { a: true };
    },
    now: () => clock,
    setTimer: (run, ms) => {
      const id = next++;
      timers.set(id, { at: clock + ms, run });
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
    hidden: () => hidden,
    onFinished: () => events.push(`finished@${clock}`),
    onStopped: () => events.push(`stopped@${clock}`),
  });
  /** Moves the clock forward, firing every timer that falls due. */
  const advance = async (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].sort((x, y) => x[1].at - y[1].at)[0];
      if (!due || due[1].at > until) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].run();
      // Let the awaited answer settle before the next timer.
      await settle();
    }
    clock = until;
  };
  return {
    poll,
    asked,
    events,
    timers,
    advance,
    hide: () => {
      hidden = true;
      poll.visibilityChanged();
    },
    show: async () => {
      hidden = false;
      poll.visibilityChanged();
      await settle();
    },
  };
}

describe('B1 · PendingWatch backs off', () => {
  it('2.5 s, 2.5 s, 5 s, 5 s, 10 s, 10 s, then every 15 s', async () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(pendingDelay)).toEqual([
      2_500, 2_500, 5_000, 5_000, 10_000, 10_000, 15_000, 15_000,
    ]);
    const h = harness();
    await h.advance(80_000);
    expect(h.asked).toEqual([2_500, 5_000, 10_000, 15_000, 25_000, 35_000, 50_000, 65_000, 80_000]);
  });

  it('an idle minute asks at most 8 times, never re-reading the page', async () => {
    const h = harness();
    await h.advance(60_000);
    expect(h.asked.length).toBeLessThanOrEqual(8);
    expect(h.events).toEqual([]);
  });
});

describe('B1 · the page is re-read once, when something finished', () => {
  it('one item done → one re-read, then no more questions', async () => {
    const h = harness([{ a: true }, { a: false }]);
    await h.advance(60_000);
    expect(h.events).toEqual(['finished@5000']);
    expect(h.asked).toEqual([2_500, 5_000]);
    expect(h.timers.size).toBe(0);
  });

  it('the status route failing is not "done": it keeps asking', async () => {
    const h = harness([null, null]);
    await h.advance(10_000);
    expect(h.events).toEqual([]);
    expect(h.asked).toEqual([2_500, 5_000, 10_000]);
  });
});

describe('B1 · a hidden tab costs nothing', () => {
  it('no timer runs while hidden; back in view it asks at once and carries on', async () => {
    const h = harness();
    await h.advance(3_000); // asked once at 2.5 s
    h.hide();
    expect(h.timers.size).toBe(0);
    await h.advance(60_000);
    expect(h.asked).toEqual([2_500]);
    await h.show();
    expect(h.asked).toEqual([2_500, 63_000]);
    // …and the back-off carries on where it left off (the third wait is 5 s).
    await h.advance(5_000);
    expect(h.asked).toEqual([2_500, 63_000, 68_000]);
  });

  it('back after the time limit: one last check — done re-reads, still going says so', async () => {
    for (const [answer, event] of [
      [{ a: false }, 'finished'],
      [{ a: true }, 'stopped'],
    ] as const) {
      const h = harness([{ a: true }, answer]);
      await h.advance(3_000);
      h.hide();
      await h.advance(30 * 60_000);
      await h.show();
      expect(h.asked).toEqual([2_500, 3_000 + 30 * 60_000]);
      expect(h.events).toEqual([`${event}@${3_000 + 30 * 60_000}`]);
      expect(h.timers.size).toBe(0);
    }
  });
});

describe('B1 · it stops after ten minutes and says so', () => {
  it('the first question past the limit is the last: "still working", and nothing after', async () => {
    const h = harness();
    await h.advance(PENDING_STOP_AFTER_MS + 60_000);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatch(/^stopped@/);
    const stoppedAt = Number(h.events[0]!.split('@')[1]);
    expect(stoppedAt).toBeGreaterThanOrEqual(PENDING_STOP_AFTER_MS);
    expect(stoppedAt).toBeLessThan(PENDING_STOP_AFTER_MS + 15_000);
    expect(h.timers.size).toBe(0);
    expect(h.asked.filter((at) => at >= PENDING_STOP_AFTER_MS)).toEqual([stoppedAt]);
  });

  it('stop() (the item left the page) clears its timer', async () => {
    const h = harness();
    h.poll.stop();
    expect(h.timers.size).toBe(0);
    await h.advance(60_000);
    expect(h.asked).toEqual([]);
  });
});
