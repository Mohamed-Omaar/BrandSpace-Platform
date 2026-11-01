import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * EVERY SWEEP `runOnce` RUNS HAS A TIMER IN `start()` (check-up 2026-10-28, M-15).
 *
 * `runOnce` is what the tests call; `start()` is what a deployment runs. Twice a
 * sweep was added to the first and not the second (`sweepPublishing`, then
 * `purgeAiApps`), and every test stayed green because none of them goes through
 * the timers. This compares the two method bodies so the third time fails here.
 */

const source = readFileSync(path.join(__dirname, '../../apps/api/src/scheduler.ts'), 'utf8');

function body(signature: RegExp): string {
  const match = signature.exec(source);
  if (!match) throw new Error(`method not found: ${signature}`);
  let depth = 0;
  const start = source.indexOf('{', match.index + match[0].length - 1);
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced method body');
}

function calls(text: string): Set<string> {
  return new Set([...text.matchAll(/this\.([A-Za-z]+)\(/g)].map((m) => m[1]!));
}

describe('maintenance scheduler timer parity', () => {
  const runOnce = calls(body(/async runOnce\(\): Promise<MaintenanceResult> \{/));
  const started = calls(body(/async start\(\): Promise<void> \{/));

  it('finds the sweeps in both methods', () => {
    expect(runOnce.size).toBeGreaterThan(10);
    expect(started.size).toBeGreaterThan(10);
  });

  it('gives every sweep runOnce runs a timer in start()', () => {
    const missing = [...runOnce].filter((name) => name !== 'cadence' && !started.has(name));
    expect(missing).toEqual([]);
  });

  it('schedules the Connected AI apps purge', () => {
    expect(started.has('purgeAiApps')).toBe(true);
  });

  it('never lets a sweep overlap its own previous pass', () => {
    const start = body(/async start\(\): Promise<void> \{/);
    expect(start).toMatch(/if \(inFlight\)/);
    expect(start).toMatch(/\.finally\(\(\) => \{\s*inFlight = false;/);
  });
});
