import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_CONFIG_CACHE_TTL_MS, TtlCache } from '@brandspace/shared';
import { concurrency } from '../../apps/dashboard/src/server/concurrency';

/**
 * PERF A — the server half of the performance work. The browser half of the
 * "never across requests" rule is tests/e2e/perf-a-freshness.spec.ts.
 */
describe('the global configuration cache', () => {
  it('never keeps anything longer than 30 seconds, whatever it is asked', () => {
    expect(MAX_CONFIG_CACHE_TTL_MS).toBe(30_000);
    expect(new TtlCache(60_000).ttlMs).toBe(30_000);
    expect(new TtlCache(5_000).ttlMs).toBe(5_000);
  });

  it('answers from memory inside the TTL and asks again after it', async () => {
    let clock = 0;
    let loads = 0;
    const cache = new TtlCache<number>(30_000, () => clock);
    const load = async () => ++loads;
    expect(await cache.get('plans:DEVELOPMENT', load)).toBe(1);
    clock = 29_999;
    expect(await cache.get('plans:DEVELOPMENT', load)).toBe(1);
    clock = 30_000;
    expect(await cache.get('plans:DEVELOPMENT', load)).toBe(2);
  });

  it('shares one load between concurrent misses, and never keeps a failure', async () => {
    let loads = 0;
    const cache = new TtlCache<number>();
    const [a, b] = await Promise.all([
      cache.get('k', async () => ++loads),
      cache.get('k', async () => ++loads),
    ]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    const failing = new TtlCache<number>();
    await expect(failing.get('k', () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(await failing.get('k', async () => 7)).toBe(7);
  });

  it('is used only for global catalogue rows in the dashboard', () => {
    const file = readFileSync('apps/dashboard/src/server/config-cache.ts', 'utf8');
    const caches = file.match(/new TtlCache</g) ?? [];
    expect(caches).toHaveLength(2);
    // The catalogue carries the kill switches: 5 s, as its own cache (ARCHITECTURE §7).
    expect(file).toMatch(/CATALOGUE_CACHE_TTL_MS = 5_000;/);
    expect(file).toMatch(
      /catalogueCache = new TtlCache<Record<string, unknown>>\(CATALOGUE_CACHE_TTL_MS\)/,
    );
    expect(file).toMatch(/contentPolicyCache = new TtlCache<ContentPolicy>\(\)/);
  });
});

describe('the session and the workspace list, once per request', () => {
  const context = readFileSync('apps/dashboard/src/server/customer-context.ts', 'utf8');

  it('uses React cache() — one request — and no module-level store', () => {
    expect(context).toMatch(/const resolveOnce = cache\(/);
    expect(context).toMatch(/const workspacesOnce = cache\(/);
    expect(context).not.toMatch(/new (Map|TtlCache)\b/);
    expect(context).not.toMatch(/^let /m);
  });

  it('every gate reads through it', () => {
    expect(context).toMatch(/return resolveOnce\(token\);/);
    expect(context.match(/listWorkspacesOnce\(token/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe('at most n reads of one page in flight', () => {
  it('never runs more than n tasks at once, and runs them all', async () => {
    const run = concurrency(4);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return index;
        }),
      ),
    );
    expect(peak).toBe(4);
    expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index));
  });

  it('passes a failure to whoever awaits it, and keeps going', async () => {
    const run = concurrency(1);
    const failed = run(() => Promise.reject(new Error('read failed')));
    const next = run(async () => 'next');
    await expect(failed).rejects.toThrow('read failed');
    expect(await next).toBe('next');
  });
});
