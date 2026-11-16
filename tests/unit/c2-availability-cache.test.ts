import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvailabilityCache } from '../../apps/dashboard/src/server/availability-cache';

/**
 * C2 (owner, 2026-11-14) — AI AVAILABILITY, ONE ANSWER PER WORKSPACE FOR A
 * SHORT WHILE, AND NEVER WAITED ON FOR LONG.
 */

afterEach(() => {
  vi.useRealTimers();
});

function harness(
  fetchImpl: (key: string, signal: AbortSignal) => Promise<Record<string, boolean>>,
) {
  let clock = 0;
  const failures: string[] = [];
  const calls: string[] = [];
  const cache = new AvailabilityCache<Record<string, boolean>>({
    ttlMs: 45_000,
    timeoutMs: 1_500,
    fallback: {},
    now: () => clock,
    onFailure: (key) => failures.push(key),
    fetch: (key, signal) => {
      calls.push(key);
      return fetchImpl(key, signal);
    },
  });
  return { cache, calls, failures, advance: (ms: number) => (clock += ms) };
}

describe('C2 · one answer per workspace for 45 s', () => {
  it('asks once, answers from memory until 45 s have passed, then asks again', async () => {
    let answer = { 'copilot.chat': true };
    const h = harness(async () => answer);
    expect(await h.cache.get('ws-a')).toEqual({ 'copilot.chat': true });
    h.advance(44_999);
    answer = { 'copilot.chat': false };
    expect(await h.cache.get('ws-a')).toEqual({ 'copilot.chat': true });
    expect(h.calls).toEqual(['ws-a']);
    h.advance(1);
    expect(await h.cache.get('ws-a')).toEqual({ 'copilot.chat': false });
    expect(h.calls).toEqual(['ws-a', 'ws-a']);
  });

  it('each workspace has its own answer', async () => {
    const h = harness(async (key) => ({ [key]: true }));
    expect(await h.cache.get('ws-a')).toEqual({ 'ws-a': true });
    expect(await h.cache.get('ws-b')).toEqual({ 'ws-b': true });
    expect(h.calls).toEqual(['ws-a', 'ws-b']);
  });

  it('callers asking at the same time share one request', async () => {
    let release: (value: Record<string, boolean>) => void = () => undefined;
    const h = harness(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = h.cache.get('ws-a');
    const second = h.cache.get('ws-a');
    release({ 'image.generate': true });
    expect(await first).toEqual({ 'image.generate': true });
    expect(await second).toEqual({ 'image.generate': true });
    expect(h.calls).toHaveLength(1);
  });
});

describe('C2 · a slow or failing API is never waited on past 1.5 s', () => {
  it('a request still going at 1.5 s is aborted; with no answer yet, nothing is available', async () => {
    vi.useFakeTimers();
    const h = harness(
      (_key, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const answer = h.cache.get('ws-a');
    await vi.advanceTimersByTimeAsync(1_499);
    let settled = false;
    void answer.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toEqual({});
    expect(h.failures).toEqual(['ws-a']);
  });

  it('a failure after a good answer keeps the last good answer', async () => {
    let fail = false;
    const h = harness(async () => {
      if (fail) throw new Error('503');
      return { 'copilot.chat': true };
    });
    expect(await h.cache.get('ws-a')).toEqual({ 'copilot.chat': true });
    h.advance(60_000);
    fail = true;
    expect(await h.cache.get('ws-a')).toEqual({ 'copilot.chat': true });
    expect(h.failures).toEqual(['ws-a']);
    // …and it asks again next time rather than trusting a failure.
    fail = false;
    await h.cache.get('ws-a');
    expect(h.calls).toHaveLength(3);
  });

  it('no answer ever: the fallback (nothing available), never a throw', async () => {
    const h = harness(async () => {
      throw new Error('down');
    });
    await expect(h.cache.get('ws-a')).resolves.toEqual({});
  });
});
