import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { measure, measureCss, regressions, stale, type Counts } from '../../scripts/style/measure';

/**
 * THE STYLE RATCHET (design-system programme, step S1).
 *
 * Hard-coded style values may only go DOWN. The counts per file and category
 * are committed in scripts/style/baseline.json; this suite measures the tree
 * and fails if any (file, category) is above its baseline — including a new
 * file that arrives with a literal in it. Since S6 the baseline is also exact:
 * a lowered count must be recorded (`pnpm style:ratchet --write`) in the same
 * change, and ESLint and stylelint error in every file the baseline no longer
 * lists (scripts/style/style-rules.mjs).
 *
 * What counts and why is documented in scripts/style/measure.ts.
 */
const root = path.resolve(__dirname, '../..');
const baseline = JSON.parse(
  readFileSync(path.join(root, 'scripts/style/baseline.json'), 'utf8'),
) as {
  css: Counts;
  ts: Counts;
};

let current: { css: Counts; ts: Counts };

beforeAll(async () => {
  current = await measure(root);
}, 120_000);

describe('hard-coded style values only ever go down', () => {
  it('measures a meaningful number of files, so a pass is not vacuous', () => {
    expect(Object.keys(current.css).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(current.ts).length).toBeGreaterThan(100);
  });

  it('no stylesheet has more literal values than its baseline', () => {
    expect(regressions(current.css, baseline.css)).toEqual([]);
  });

  it('no TS/TSX file has more literal values or inline styles than its baseline', () => {
    expect(regressions(current.ts, baseline.ts)).toEqual([]);
  });
  /*
   * S6 — STRICT: the baseline is exact. A count that went down is recorded by
   * the PR that lowered it (`pnpm style:ratchet --write`), so the next change
   * cannot quietly spend the room it left.
   */
  it('the stylesheet baseline is exact: every lowered count is recorded', () => {
    expect(stale(current.css, baseline.css)).toEqual([]);
  });

  it('the TS/TSX baseline is exact: every lowered count is recorded', () => {
    expect(stale(current.ts, baseline.ts)).toEqual([]);
  });
});

describe('the measurement itself', () => {
  it('counts a literal colour, length, duration, z-index and blur', () => {
    const counts = measureCss(
      '.a { color: #fff; padding: 12px 8px; transition: opacity 200ms ease; z-index: 70; backdrop-filter: blur(30px); }',
    );
    expect(counts).toEqual({
      colour: 1,
      spacing: 2,
      duration: 1,
      easing: 1,
      'z-index': 1,
      blur: 1,
    });
  });

  it('never counts a token reference or a token definition', () => {
    expect(
      measureCss(
        ':root { --bs-ink: #111114; } .a { color: var(--bs-ink); padding: var(--bsp-px-12, 12px); }',
      ),
    ).toEqual({});
  });

  it('never counts zero, keywords or percentages', () => {
    expect(measureCss('.a { margin: 0; inline-size: 100%; color: currentColor; }')).toEqual({});
  });

  it('flags a planted regression as a regression', () => {
    const up = regressions({ 'x.css': { colour: 2 } }, { 'x.css': { colour: 1 } });
    expect(up).toEqual(['x.css colour: 1 -> 2']);
    expect(regressions({ 'new.css': { colour: 1 } }, {})).toEqual(['new.css colour: 0 -> 1']);
    expect(regressions({ 'x.css': { colour: 1 } }, { 'x.css': { colour: 3 } })).toEqual([]);
  });
});
