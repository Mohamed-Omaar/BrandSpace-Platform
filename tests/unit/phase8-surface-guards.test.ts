import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TWO PROMISES THE CUSTOMER SURFACE MAKES, CHECKED AT THE SOURCE — Phase 8.
 *
 * Both are claims about what is ABSENT, which is why they are guards over the
 * repository rather than assertions in a browser: a test that opens a screen
 * proves only that today's data did not trigger the thing. Reading the files
 * proves nobody can write it.
 */

const DASHBOARD_SRC = resolve(import.meta.dirname, '../../apps/dashboard/src');

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      // `module-boundaries.test.ts` writes a `__boundary_probe.ts` here and
      // deletes it again; the suites run together, so a scan could list it and
      // then find it gone (ENOENT). It is that suite's artifact, not source —
      // the same race `design-system.test.ts` already guards against.
      if (entry.startsWith('__boundary_probe')) continue;
      const full = resolve(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe('AC-28.8 — no model, provider or prompt is named in the customer surface', () => {
  /*
   * WHAT IS BEING PROTECTED. A customer buys an outcome, not a vendor. Naming
   * the model that wrote a caption turns a product decision into a support
   * conversation about it, makes routing a promise rather than an operator's
   * choice, and leaks which provider a workspace's data reached — which is
   * exactly the coupling `docs/AI-GATEWAY.md` exists to prevent.
   *
   * THE LIST IS OF VENDOR AND MODEL FAMILIES, not of the word "AI". "AI
   * Creative Studio" is the product's own name for a feature and belongs on
   * the screen; "gpt-4o" never does.
   */
  const FORBIDDEN = [
    'openai',
    'anthropic',
    'claude-',
    'gpt-',
    'gemini',
    'mistral',
    'llama',
    'stable-diffusion',
    'dall-e',
    'midjourney',
    'mock-fast',
  ] as const;

  for (const file of sourceFiles(DASHBOARD_SRC)) {
    const relative = file.slice(file.indexOf('apps/dashboard'));
    it(`${relative} names no provider or model`, () => {
      const lower = readFileSync(file, 'utf8').toLowerCase();
      const found = FORBIDDEN.filter((needle) => lower.includes(needle));
      expect(found, `${relative} names a provider or model`).toEqual([]);
    });
  }
});

describe('AC-26.4 — campaign performance is the Phase 7 analytics layer, not a second one', () => {
  const page = readFileSync(
    resolve(DASHBOARD_SRC, 'app/[locale]/campaigns/[campaignId]/page.tsx'),
    'utf8',
  );

  it('reads through the analytics query service', () => {
    expect(page).toContain('inAnalytics');
    expect(page).toContain('services.queries()');
    expect(page).toContain('queries.summary(');
  });

  it('computes no figures of its own', () => {
    /*
     * A SECOND ANALYTICS STACK ANNOUNCES ITSELF AS ARITHMETIC. Campaign
     * performance that summed, averaged or grouped observations here would be
     * a second implementation of the thing `AnalyticsQueryService` exists to
     * be — and would drift from it the first time a metric's semantics
     * changed (a level metric is its LATEST reading, not its largest; that
     * lesson is P7-R7's).
     */
    expect(page).not.toContain('metricObservation');
    expect(page).not.toContain('$queryRaw');
    expect(page).not.toMatch(/\.reduce\(/);
  });

  it('asks only for the campaign it is showing, scoped to its own brand', () => {
    // The campaign's OWN brand, read off the campaign — never the globally
    // selected one, which would reinterpret which brand an existing object
    // belongs to (D-190).
    expect(page).toContain('campaignId');
    expect(page).toMatch(/brandId: campaign\.brandId/);
  });
});
