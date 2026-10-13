import { describe, expect, it } from 'vitest';
import {
  timeoutSecondsFrom,
  waitForMigrations,
} from '../../packages/database/prisma/wait-for-migrations';
import { schemaReadinessFrom } from '../../packages/database/src/schema-readiness';

/**
 * THE PRE-DEPLOY WAIT (step B, the #80 deploy race): a release waits for its
 * migrations BEFORE it starts, so the healthcheck clock never runs out on a
 * migration that is merely slower than the deploy. Ready → exit 0; past the
 * deadline → exit 1 naming what is pending; a database that cannot be read is
 * "not yet", never a crash. It logs migration names only.
 */

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe('wait-for-migrations', () => {
  it('returns as soon as every expected migration is applied', async () => {
    const c = clock();
    const answers = [['a'], ['a', 'b'], ['a', 'b', 'c']];
    const lines: string[] = [];
    const ready = await waitForMigrations({
      read: async () => schemaReadinessFrom(answers.shift() ?? ['a', 'b', 'c'], ['a', 'b', 'c']),
      timeoutMs: 60_000,
      intervalMs: 5_000,
      ...c,
      log: (line) => lines.push(line),
    });
    expect(ready).toBe(true);
    expect(c.now()).toBe(10_000);
    expect(lines[0]).toBe('wait-for-migrations: waiting for 2: b, c');
    expect(lines.at(-1)).toBe('wait-for-migrations: every migration this build needs is applied');
  });

  it('gives up after the deadline, naming what is still pending', async () => {
    const c = clock();
    const lines: string[] = [];
    const ready = await waitForMigrations({
      read: async () => schemaReadinessFrom(['a'], ['a', 'b']),
      timeoutMs: 20_000,
      intervalMs: 5_000,
      ...c,
      log: (line) => lines.push(line),
    });
    expect(ready).toBe(false);
    expect(lines).toEqual([
      'wait-for-migrations: waiting for 1: b',
      'wait-for-migrations: gave up after 20 s',
    ]);
  });

  it('a database that cannot be read yet is "not yet", not a crash, and no detail is logged', async () => {
    const c = clock();
    let calls = 0;
    const lines: string[] = [];
    const ready = await waitForMigrations({
      read: async () => {
        calls += 1;
        if (calls < 3) throw new Error('connect ECONNREFUSED postgres://user:secret@host');
        return schemaReadinessFrom(['a'], ['a']);
      },
      timeoutMs: 60_000,
      ...c,
      log: (line) => lines.push(line),
    });
    expect(ready).toBe(true);
    expect(lines.join('\n')).not.toMatch(/secret|postgres:|ECONNREFUSED/);
  });

  it('the timeout is a positive whole number of seconds, default 30 minutes', () => {
    expect(timeoutSecondsFrom(undefined)).toBe(1_800);
    expect(timeoutSecondsFrom('600')).toBe(600);
    expect(timeoutSecondsFrom('0')).toBe(1_800);
    expect(timeoutSecondsFrom('abc')).toBe(1_800);
    expect(timeoutSecondsFrom('1.5')).toBe(1_800);
  });
});
